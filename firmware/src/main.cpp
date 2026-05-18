#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <esp_adc_cal.h>
#include <SPIFFS.h>

// ── Pins ──────────────────────────────────────────────────────────
#define STEP_PIN     27
#define DIR_PIN      26
#define EN_PIN       25
#define PH_PIN       32
#define TEMP_PIN     33

// ── Speed constants (µs between steps) ───────────────────────────
#define STEP_DELAY_FLUSH        200
#define STEP_DELAY_NORMAL       1000
#define STEP_DELAY_SLOW         3000
#define STEP_DELAY_MIN          100
#define STEP_DELAY_MAX          10000
#define TIT_SPEED_UPDATE_FREQ   20

// ── Titration speed control ───────────────────────────────────────
#define TIT_MIN_DELAY   400       // µs step delay at zero dU/dV (full speed)
#define TIT_MAX_DELAY   4000      // µs step delay at high dU/dV (slowest)
#define TIT_EXP_SCALE   1500.0f   // |dU/dV| (mV/mL) at which pump reaches TIT_MAX_DELAY

// ── Calibration constants ─────────────────────────────────────────
#define CALIBRATION_STEPS     50000
#define DEFAULT_STEPS_PER_ML  36000.0f
#define ADC_SAMPLES           256     // average this many reads for stability
#define U_EMA_ALPHA           0.2f    // exponential moving average factor for voltage smoothing
#define DUDV_EMA_ALPHA        0.05f    // EMA factor for dU/dV smoothing (higher = more responsive)
#define WDT_YIELD_EVERY       10

// ── BLE UUIDs ────────────────────────────────────────────────────
#define SERVICE_UUID     "1aa974de-6f63-4a76-8a1f-aab707432a77"
#define CMD_CHAR_UUID    "d3951d7f-bf1e-4ad7-9da9-04cef4d5aabb"
#define STATUS_CHAR_UUID "a493eaf8-8638-4375-8445-14fef39fb459"

// ── Globals ──────────────────────────────────────────────────────
NimBLECharacteristic* pStatusChar = nullptr;
Preferences preferences;
bool bleConnected             = false;
volatile bool flushing        = false;
volatile int currentStepDelay = STEP_DELAY_NORMAL;
String serialBuffer           = "";
volatile bool streaming       = false;
const unsigned long STREAM_INTERVAL_MS = 100;

// ── Forward declarations ──────────────────────────────────────────
void respond(const String& msg);

// ── TROWS streaming state (ACK-based flow control) ───────────────
static File titStreamFile;
static int  titStreamId     = -1;
static bool titStreamOpen   = false;
static int  titStreamStride = 1;

void sendNextTrows() {
    if (!titStreamOpen) return;
    String chunk = "TROWS ";
    int    count = 0;
    while (titStreamFile.available() >= 8) {
        uint32_t pos = titStreamFile.position();
        float vol, ph;
        titStreamFile.read((uint8_t*)&vol, 4);
        titStreamFile.read((uint8_t*)&ph,  4);
        String point = (count > 0 ? ";" : "") + String(vol, 4) + "," + String(ph, 3);
        if (count > 0 && chunk.length() + point.length() > 480) {
            titStreamFile.seek(pos);  // won't fit — save this point for the next chunk
            break;
        }
        chunk += point;
        count++;
        if (titStreamStride > 1)
            titStreamFile.seek(titStreamFile.position() + (uint32_t)(titStreamStride - 1) * 8);
    }
    if (count > 0) {
        respond(chunk);
    } else {
        titStreamFile.close();
        titStreamOpen = false;
        respond("TDATA_END " + String(titStreamId));
        titStreamId = -1;
    }
}

// ── pH calibration state ──────────────────────────────────────────
// Stores up to 3 calibration points as (mV, pH) pairs
// Calibration curve: pH = a * mV + b  (linear, 2-point)
//                 or pH = a * mV² + b * mV + c  (quadratic, 3-point)
struct PhCalPoint { uint32_t mV; float ph; };
PhCalPoint phCalPoints[3];
int phCalPointCount = 0;
float phCalA = 0, phCalB = 7, phCalC = 0;  // curve coefficients
bool phCalValid = false;
int phCalDegree = 1;  // 1 = linear, 2 = quadratic
float phCalLinDev = -1;  // linearity deviation % (0 = perfect), -1 = N/A

struct StepRequest {
    long steps;
    int  delayUs;
    bool isCalibration;
    bool isTitration;   // enters autonomous titration loop when true
};

// ── Titration state ───────────────────────────────────────────────
volatile bool  titRunning   = false;
volatile bool  titPause     = false;
volatile bool  titDone      = false;
volatile long  titStepCount = 0;

float titTotalMl      = 0;
float titStepsPerMl   = DEFAULT_STEPS_PER_ML;
int   titDirection    = 1;
int   titId           = 0;
File  titFile;

volatile float titLastAbsDUDV = 0.0f;  // written Core 0, read Core 1 (32-bit atomic)
float mvEma   = -1.0f;                 // EMA of millivolts; -1 = uninitialised sentinel
float dUdVEma = -1.0f;                 // EMA of |dU/dV|; -1 = uninitialised sentinel

// Rolling buffer for dU/dV computation (Core 0 only)
#define DERIV_BUF 6
struct TPoint { float volume; float voltage; };
TPoint derivBuf[DERIV_BUF];
int    derivCount = 0;

QueueHandle_t stepQueue;

// ── ADC calibration ──────────────────────────────────────────────
esp_adc_cal_characteristics_t adcChars;

// ── ADC helper ────────────────────────────────────────────────────
int readADCAveraged(int pin) {
    long sum = 0;
    for (int i = 0; i < ADC_SAMPLES; i++) {
        sum += analogRead(pin);
        delayMicroseconds(100);
    }
    return (int)(sum / ADC_SAMPLES);
}

uint32_t adcToMillivolts(int adc) {
    return esp_adc_cal_raw_to_voltage(adc, &adcChars);
}

// ── Motor helpers ─────────────────────────────────────────────────
void enableMotor()  { digitalWrite(EN_PIN, LOW); }
void disableMotor() { digitalWrite(EN_PIN, HIGH); }

void stepOnce(int delayUs) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(delayUs);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(delayUs);
}

// ── Respond ───────────────────────────────────────────────────────
void respond(const String& msg) {
    Serial.println(msg.c_str());
    if (pStatusChar && bleConnected) {
        pStatusChar->setValue(msg.c_str());
        pStatusChar->notify();
    }
}

// ── NVS ───────────────────────────────────────────────────────────
void savePumpCalibration(float stepsPerMl) {
    preferences.begin("titrinator", false);
    preferences.putFloat("steps_per_ml", stepsPerMl);
    preferences.end();
}

float loadPumpCalibration() {
    preferences.begin("titrinator", true);
    float val = preferences.getFloat("steps_per_ml", DEFAULT_STEPS_PER_ML);
    preferences.end();
    return val;
}

void savePhCalibration() {
    preferences.begin("titrinator", false);
    preferences.putInt("ph_degree", phCalDegree);
    preferences.putFloat("ph_a", phCalA);
    preferences.putFloat("ph_b", phCalB);
    preferences.putFloat("ph_c", phCalC);
    preferences.putFloat("ph_lindev", phCalLinDev);
    preferences.putInt("ph_points", phCalPointCount);
    for (int i = 0; i < phCalPointCount; i++) {
        preferences.putUInt(("ph_mv" + String(i)).c_str(), phCalPoints[i].mV);
        preferences.putFloat(("ph_ph" + String(i)).c_str(), phCalPoints[i].ph);
    }
    preferences.end();
}

void loadPhCalibration() {
    preferences.begin("titrinator", true);
    phCalDegree      = preferences.getInt("ph_degree", 1);
    phCalA           = preferences.getFloat("ph_a", 0);
    phCalB           = preferences.getFloat("ph_b", 7);
    phCalC           = preferences.getFloat("ph_c", 0);
    phCalLinDev      = preferences.getFloat("ph_lindev", -1);
    phCalPointCount  = preferences.getInt("ph_points", 0);
    for (int i = 0; i < phCalPointCount; i++) {
        phCalPoints[i].mV = preferences.getUInt(("ph_mv" + String(i)).c_str(), 0);
        phCalPoints[i].ph = preferences.getFloat(("ph_ph" + String(i)).c_str(), 0);
    }
    phCalValid = (phCalPointCount >= 2);
    preferences.end();
}

// ── SPIFFS space management ───────────────────────────────────────
// Deletes the oldest (lowest-ID) titration file to free space.
// Returns true if a file was deleted.
bool deleteOldestTitration() {
    int oldestId = -1;
    File root = SPIFFS.open("/");
    if (!root || !root.isDirectory()) return false;
    File f = root.openNextFile();
    while (f) {
        String name = f.name();
        if (name.startsWith("tit_") && name.endsWith(".bin")) {
            int id = name.substring(4, name.length() - 4).toInt();
            if (oldestId < 0 || id < oldestId) oldestId = id;
        }
        f.close();
        f = root.openNextFile();
    }
    root.close();
    if (oldestId < 0) return false;
    return SPIFFS.remove("/tit_" + String(oldestId) + ".bin");
}

// ── pH curve fitting ──────────────────────────────────────────────
void fitPhCurve() {
    phCalLinDev = -1;  // reset; only set for 3-point
    if (phCalPointCount == 2) {
        // Linear: pH = a * mV + b
        phCalDegree = 1;
        float x0 = (float)phCalPoints[0].mV, y0 = phCalPoints[0].ph;
        float x1 = (float)phCalPoints[1].mV, y1 = phCalPoints[1].ph;
        phCalA = (y1 - y0) / (x1 - x0);
        phCalB = y0 - phCalA * x0;
        phCalC = 0;
    } else if (phCalPointCount == 3) {
        // Quadratic: pH = a*mV² + b*mV + c via Lagrange interpolation
        phCalDegree = 2;
        float x0 = (float)phCalPoints[0].mV, y0 = phCalPoints[0].ph;
        float x1 = (float)phCalPoints[1].mV, y1 = phCalPoints[1].ph;
        float x2 = (float)phCalPoints[2].mV, y2 = phCalPoints[2].ph;
        float d = (x0-x1)*(x0-x2)*(x1-x2);
        phCalA = (x2*(y1-y0) + x1*(y0-y2) + x0*(y2-y1)) / d;
        phCalB = (x2*x2*(y0-y1) + x1*x1*(y2-y0) + x0*x0*(y1-y2)) / d;
        phCalC = (x1*x2*(x1-x2)*y0 + x0*x2*(x2-x0)*y1 + x0*x1*(x0-x1)*y2) / d;

        // Linearity deviation: (1 - R²) of a linear fit to the 3 points
        float sumX = x0 + x1 + x2, sumY = y0 + y1 + y2;
        float sumXY = x0*y0 + x1*y1 + x2*y2;
        float sumX2 = x0*x0 + x1*x1 + x2*x2;
        float sumY2 = y0*y0 + y1*y1 + y2*y2;
        float num = 3*sumXY - sumX*sumY;
        float den2 = (3*sumX2 - sumX*sumX) * (3*sumY2 - sumY*sumY);
        float r2 = (den2 > 0) ? (num * num) / den2 : 0;
        phCalLinDev = (1.0f - r2) * 100.0f;
    }
    phCalValid = true;
    savePhCalibration();
}

// ── Titration speed controller (called from motor task, Core 1) ───
void updateTitSpeed() {
    float dudv = titLastAbsDUDV;   // 32-bit float read — atomic on ESP32
    float t = fminf(1.0f, dudv / TIT_EXP_SCALE);
    currentStepDelay = (int)(TIT_MIN_DELAY * powf((float)TIT_MAX_DELAY / TIT_MIN_DELAY, t));
}

// ── Motor task ────────────────────────────────────────────────────
void motorTask(void* pvParameters) {
    esp_task_wdt_delete(NULL);
    StepRequest req;
    for (;;) {
        if (xQueueReceive(stepQueue, &req, portMAX_DELAY)) {
            if (req.isTitration) {
                // ── Autonomous titration flow ──────────────────────
                titStepCount = 0;
                currentStepDelay = TIT_MIN_DELAY;
                digitalWrite(DIR_PIN, titDirection > 0 ? HIGH : LOW);
                enableMotor();
                while (titRunning) {
                    if (titPause) {
                        vTaskDelay(pdMS_TO_TICKS(10));
                        continue;
                    }
                    stepOnce(currentStepDelay);
                    titStepCount++;
                    if (titStepCount % TIT_SPEED_UPDATE_FREQ == 0) {
                        updateTitSpeed();
                        float dispensed = (float)titStepCount / titStepsPerMl;
                        if (dispensed >= titTotalMl) titRunning = false;
                    }
                    if (titStepCount % WDT_YIELD_EVERY == 0) taskYIELD();
                }
                disableMotor();
                titDone = true;   // signal main loop to close file and notify

            } else if (req.steps == 0) {
                digitalWrite(DIR_PIN, HIGH);
                enableMotor();
                long i = 0;
                while (flushing) {
                    stepOnce(STEP_DELAY_FLUSH);
                    if (++i % WDT_YIELD_EVERY == 0) taskYIELD();
                }
                disableMotor();
            } else {
                digitalWrite(DIR_PIN, req.steps > 0 ? HIGH : LOW);
                long absSteps = abs(req.steps);
                enableMotor();
                for (long i = 0; i < absSteps; i++) {
                    stepOnce(req.delayUs);
                    if ((i + 1) % WDT_YIELD_EVERY == 0) taskYIELD();
                }
                disableMotor();
                if (req.isCalibration) {
                    respond("CAL_DONE " + String(req.steps));
                } else {
                    respond("DONE " + String(req.steps));
                }
            }
        }
    }
}

// ── Command parser ────────────────────────────────────────────────
void handleCommand(const String& raw) {
    String cmd = raw;
    cmd.trim();
    if (cmd.length() == 0) return;

    if (cmd.startsWith("STEP")) {
        long steps = 0;
        int spaceIdx = cmd.indexOf(' ', 5);
        if (spaceIdx > 0) {
            steps = cmd.substring(5, spaceIdx).toInt();
            int delayUs = constrain(cmd.substring(spaceIdx + 1).toInt(),
                                    STEP_DELAY_MIN, STEP_DELAY_MAX);
            StepRequest req = { steps, delayUs, false };
            xQueueSend(stepQueue, &req, portMAX_DELAY);
        } else {
            steps = cmd.substring(5).toInt();
            StepRequest req = { steps, currentStepDelay, false };
            xQueueSend(stepQueue, &req, portMAX_DELAY);
        }

    } else if (cmd == "FLUSH") {
        flushing = true;
        StepRequest req = { 0, STEP_DELAY_FLUSH, false };
        xQueueSend(stepQueue, &req, portMAX_DELAY);
        respond("FLUSHING");

    } else if (cmd == "STOP") {
        flushing = false;
        disableMotor();
        respond("STOPPED");

    } else if (cmd == "CALIBRATE") {
        StepRequest req = { CALIBRATION_STEPS, STEP_DELAY_NORMAL, true };
        xQueueSend(stepQueue, &req, portMAX_DELAY);

    } else if (cmd.startsWith("SET_SPEED")) {
        String mode = cmd.substring(10);
        mode.trim();
        if (mode == "FAST")        currentStepDelay = STEP_DELAY_FLUSH;
        else if (mode == "NORMAL") currentStepDelay = STEP_DELAY_NORMAL;
        else if (mode == "SLOW")   currentStepDelay = STEP_DELAY_SLOW;
        else { respond("ERR unknown speed: " + mode); return; }
        respond("SPEED " + mode + " " + String(currentStepDelay));

    } else if (cmd.startsWith("SET_DELAY")) {
        int delayUs = constrain(cmd.substring(10).toInt(),
                                STEP_DELAY_MIN, STEP_DELAY_MAX);
        currentStepDelay = delayUs;
        respond("DELAY " + String(currentStepDelay));

    } else if (cmd == "GET_SPEED") {
        String preset = "CUSTOM";
        if (currentStepDelay == STEP_DELAY_FLUSH)  preset = "FAST";
        if (currentStepDelay == STEP_DELAY_NORMAL) preset = "NORMAL";
        if (currentStepDelay == STEP_DELAY_SLOW)   preset = "SLOW";
        respond("SPEED " + preset + " " + String(currentStepDelay));

    } else if (cmd.startsWith("SET_CAL")) {
        float stepsPerMl = cmd.substring(8).toFloat();
        if (stepsPerMl > 0) {
            savePumpCalibration(stepsPerMl);
            respond("CAL_SAVED " + String(stepsPerMl));
        } else {
            respond("ERR invalid calibration value");
        }

    } else if (cmd == "GET_PUMP_CAL") {
        respond("PUMP_CAL " + String(loadPumpCalibration()));

    } else if (cmd == "STREAM_START") {
        streaming = true;
        mvEma = -1.0f;
        // (streaming task uses vTaskDelayUntil; no lastStreamMs needed)
        respond("STREAMING");

    } else if (cmd == "STREAM_STOP") {
        streaming = false;
        respond("STREAM_STOPPED");

    } else if (cmd == "PH_CAL_RESET") {
        phCalPointCount = 0;
        phCalValid = false;
        savePhCalibration();
        respond("PH_CAL_RESET");

    } else if (cmd == "PH_CAL_FIT") {
        if (phCalPointCount < 2) {
            respond("ERR need at least 2 points");
            return;
        }
        fitPhCurve();
        String calMsg = "PH_CAL_SAVED degree=" + String(phCalDegree) +
                " a=" + String(phCalA, 12) +
                " b=" + String(phCalB, 12) +
                " c=" + String(phCalC, 12);
        if (phCalLinDev >= 0)
            calMsg += " lindev=" + String(phCalLinDev, 4);
        respond(calMsg);

    } else if (cmd == "GET_PH_CAL") {
        if (phCalValid) {
            String calInfo = "PH_CAL degree=" + String(phCalDegree) +
                    " a=" + String(phCalA, 12) +
                    " b=" + String(phCalB, 12) +
                    " c=" + String(phCalC, 12) +
                    " points=" + String(phCalPointCount);
            if (phCalLinDev >= 0)
                calInfo += " lindev=" + String(phCalLinDev, 4);
            respond(calInfo);
        } else {
            respond("PH_CAL_NONE");
        }

    } else if (cmd == "STATUS") {
        respond("OK delay=" + String(currentStepDelay) +
                " cal=" + String(loadPumpCalibration()) +
                " ph_cal=" + String(phCalValid ? "yes" : "no"));

    } else if (cmd.startsWith("TSTART")) {
        // TSTART <volume_ml> <steps_per_ml> <direction>
        if (titRunning) { respond("ERR titration already running"); return; }
        int p = 7;  // skip "TSTART "
        auto tok = [&]() {
            while (p < (int)cmd.length() && cmd[p] == ' ') p++;
            int s = p;
            while (p < (int)cmd.length() && cmd[p] != ' ') p++;
            return cmd.substring(s, p);
        };
        titTotalMl    = tok().toFloat();
        titStepsPerMl = tok().toFloat();
        titDirection  = tok().toInt();
        Serial.printf("[TSTART] totalMl=%.4f stepsPerMl=%.2f dir=%d\n",
                      titTotalMl, titStepsPerMl, titDirection);
        if (titTotalMl <= 0 || titStepsPerMl <= 0) {
            respond("ERR invalid TSTART params"); return;
        }
        mvEma   = -1.0f;
        dUdVEma = -1.0f;
        derivCount = 0;
        // Increment and persist titration index
        preferences.begin("titrinator", false);
        titId = preferences.getInt("tit_index", 0) + 1;
        preferences.putInt("tit_index", titId);
        preferences.end();
        // Evict oldest titrations until at least 0.2 MB is free
        while ((SPIFFS.totalBytes() - SPIFFS.usedBytes()) < 200 * 1024) {
            if (!deleteOldestTitration()) break;
        }
        String path = "/tit_" + String(titId) + ".bin";
        titFile = SPIFFS.open(path, "w");
        if (!titFile) { respond("ERR cannot open " + path); return; }
        // Write header: id (4B) | totalMl (4B) | direction (1B) | pad (3B)
        uint32_t hId = (uint32_t)titId;
        titFile.write((uint8_t*)&hId,       4);
        titFile.write((uint8_t*)&titTotalMl, 4);
        int8_t hDir = (int8_t)titDirection;
        titFile.write((uint8_t*)&hDir, 1);
        uint8_t pad[3] = {0, 0, 0};
        titFile.write(pad, 3);
        titFile.flush();
        // Reset state
        derivCount = 0;
        titLastAbsDUDV = 0.0f;
        titRunning = true;
        titPause   = false;
        titDone    = false;
        StepRequest req = { 0, TIT_MIN_DELAY, false, true };
        xQueueSend(stepQueue, &req, portMAX_DELAY);
        respond("TRUN_START " + String(titId));

    } else if (cmd == "TSTOP") {
        titPause   = false;
        titRunning = false;
        respond("TSTOPPED");

    } else if (cmd == "TPAUSE") {
        titPause = true;
        respond("TPAUSED");

    } else if (cmd == "TRESUME") {
        titPause = false;
        respond("TRESUMED");

    } else if (cmd == "LIST_TITRATIONS") {
        File root = SPIFFS.open("/");
        if (!root || !root.isDirectory()) {
            respond("TMETA_END 0");
            return;
        }
        // Collect matching file paths first, then close the directory
        String paths[32];
        int pathCount = 0;
        File f = root.openNextFile();
        while (f && pathCount < 32) {
            String name = f.name();
            if (name.startsWith("tit_") && name.endsWith(".bin"))
                paths[pathCount++] = "/" + name;
            f = root.openNextFile();
        }
        root.close();

        int count = 0;
        String batch = "";
        for (int pi = 0; pi < pathCount; pi++) {
            File tf = SPIFFS.open(paths[pi], "r");
            if (!tf) continue;
            long fsize = tf.size();
            int points = (fsize > 12) ? (fsize - 12) / 8 : 0;
            uint32_t fId = 0; float fMl = 0; int8_t fDir = 0;
            tf.read((uint8_t*)&fId, 4);
            tf.read((uint8_t*)&fMl, 4);
            tf.read((uint8_t*)&fDir, 1);
            tf.close();
            if (batch.length() > 0) batch += "\n";
            batch += "TMETA " + String(fId) + " " + String(fMl, 2) +
                     " " + String(points) + " " + String(fDir);
            count++;
        }
        if (batch.length() > 0) batch += "\n";
        batch += "TMETA_END " + String(count);
        batch += "\nMEM_INFO " + String(SPIFFS.usedBytes()) + " " + String(SPIFFS.totalBytes());
        respond(batch);

    } else if (cmd.startsWith("GET_TITRATION ")) {
        if (titStreamOpen) { titStreamFile.close(); titStreamOpen = false; }
        String rest  = cmd.substring(14);
        int    space = rest.indexOf(' ');
        int    id    = (space >= 0) ? rest.substring(0, space).toInt() : rest.toInt();
        int    strideOverride = (space >= 0) ? rest.substring(space + 1).toInt() : 0;
        String path = "/tit_" + String(id) + ".bin";
        titStreamFile = SPIFFS.open(path, "r");
        if (!titStreamFile) { respond("ERR not found: " + path); return; }
        int totalPoints = (titStreamFile.size() > 12) ? (titStreamFile.size() - 12) / 8 : 1;
        titStreamStride = (strideOverride > 0) ? strideOverride : max(1, totalPoints / 1000);
        titStreamFile.seek(12);  // skip header
        titStreamId   = id;
        titStreamOpen = true;
        sendNextTrows();

    } else if (cmd == "TROWS_ACK") {
        sendNextTrows();

    } else if (cmd.startsWith("DEL_TITRATION ")) {
        int id = cmd.substring(14).toInt();
        String path = "/tit_" + String(id) + ".bin";
        if (SPIFFS.remove(path)) {
            respond("TDELETED " + String(id));
        } else {
            respond("ERR not found: " + path);
        }

    } else if (cmd.startsWith("PH_CAL_SET")) {
    // PH_CAL_SET <mV> <ph> — store a calibration point with known mV value
    int space1    = cmd.indexOf(' ', 11);
    uint32_t mV   = (uint32_t)cmd.substring(11, space1).toInt();
    float ph      = cmd.substring(space1 + 1).toFloat();
    if (phCalPointCount >= 3) {
        respond("ERR max 3 calibration points");
        return;
    }
    phCalPoints[phCalPointCount++] = { mV, ph };
    respond("PH_POINT " + String(phCalPointCount) +
            " mV=" + String(mV) + " ph=" + String(ph, 2));
            
    } else if (cmd == "GET_STATUS") {
        if (titRunning) {
            respond("STATUS_TITRATING " + String(titId) + " " + String(titTotalMl, 2) + " " + String(titDirection));
        } else {
            respond("STATUS_IDLE");
        }

    } else {
        respond("ERR unknown command: " + cmd);
    }
}

// ── BLE Callbacks ─────────────────────────────────────────────────
class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) override {
        bleConnected = true;
        Serial.println("BLE client connected");
    }
    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override {
        bleConnected = false;
        flushing = false;
        if (!titRunning) disableMotor();  // keep motor stepping during active titration
        if (titStreamOpen) { titStreamFile.close(); titStreamOpen = false; titStreamId = -1; }
        Serial.println("BLE client disconnected");
        NimBLEDevice::startAdvertising();
    }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pChar, NimBLEConnInfo& connInfo) override {
        handleCommand(String(pChar->getValue().c_str()));
    }
};

// ── Streaming task (Core 0) ───────────────────────────────────────
// Runs independently of the motor task on Core 1. Handles pH sampling,
// TDATA/PH_STREAM notifications, and titration-complete detection.
void streamingTask(void* pvParameters) {
    TickType_t lastWake = xTaskGetTickCount();
    while (true) {
        vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(STREAM_INTERVAL_MS));

        // Titration completion — close file and notify
        if (titDone) {
            titDone = false;
            float finalMl = (float)titStepCount / titStepsPerMl;
            if (titFile) { titFile.flush(); titFile.close(); }
            respond("TRUN_DONE " + String(finalMl, 4));
        }

        if (!streaming && !titRunning) continue;

        int rawAdc = readADCAveraged(PH_PIN);
        uint32_t mV = adcToMillivolts(rawAdc);

        // EMA in mV space — physically meaningful, used for all computation
        if (mvEma < 0.0f) mvEma = (float)mV;
        else mvEma = U_EMA_ALPHA * (float)mV + (1.0f - U_EMA_ALPHA) * mvEma;

        if (titRunning && !titPause) {
            float vol = (float)titStepCount / titStepsPerMl;
            // Derivative in mV space for speed control (Core 0 only)
            derivBuf[derivCount % DERIV_BUF] = { vol, mvEma };
            derivCount++;
            if (derivCount >= DERIV_BUF) {
                TPoint& a = derivBuf[derivCount % DERIV_BUF];         // oldest (next slot)
                TPoint& b = derivBuf[(derivCount - 1) % DERIV_BUF];  // newest
                float dV = b.volume - a.volume;
                if (dV > 0.00001f) {
                    float rawDUdV = fabsf((b.voltage - a.voltage) / dV);
                    if (dUdVEma < 0.0f) dUdVEma = rawDUdV;
                    else dUdVEma = DUDV_EMA_ALPHA * rawDUdV + (1.0f - DUDV_EMA_ALPHA) * dUdVEma;
                    titLastAbsDUDV = dUdVEma;
                }
            }
            // Compute pH from mV using calibration curve
            float phNow = phCalDegree == 2
                ? phCalA * mvEma * mvEma + phCalB * mvEma + phCalC
                : phCalA * mvEma + phCalB;
            if (titFile) {
                titFile.write((uint8_t*)&vol,   4);
                titFile.write((uint8_t*)&phNow, 4);
                titFile.flush();
            }
            respond("TDATA " + String(vol, 4) + " " + String(phNow, 3));
        } else if (streaming) {
            respond("DATA_STREAM " + String((int)mvEma));
        }
    }
}

// ── Setup ─────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);

    pinMode(STEP_PIN, OUTPUT);
    pinMode(DIR_PIN,  OUTPUT);
    pinMode(EN_PIN,   OUTPUT);
    disableMotor();

    // ADC setup
    analogReadResolution(12);
    analogSetAttenuation(ADC_11db);  // 0-3.3V range
    esp_adc_cal_characterize(ADC_UNIT_1, ADC_ATTEN_DB_11,
                             ADC_WIDTH_BIT_12, 1100, &adcChars);

    loadPhCalibration();

    if (!SPIFFS.begin(true)) {
        Serial.println("SPIFFS mount failed — reformatted");
    }
    // Load last titration index from NVS
    preferences.begin("titrinator", true);
    titId = preferences.getInt("tit_index", 0);
    preferences.end();

    stepQueue = xQueueCreate(10, sizeof(StepRequest));
    xTaskCreatePinnedToCore(motorTask,    "motorTask",   4096, NULL, 2, NULL, 1);
    xTaskCreatePinnedToCore(streamingTask, "streamTask", 4096, NULL, 1, NULL, 0);

    NimBLEDevice::init("Titrinator-00000");
    NimBLEDevice::setMTU(512);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9);

    NimBLEServer* pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    NimBLEService* pService = pServer->createService(SERVICE_UUID);

    NimBLECharacteristic* pCmdChar = pService->createCharacteristic(
        CMD_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    pCmdChar->setCallbacks(new CommandCallbacks());

    pStatusChar = pService->createCharacteristic(
        STATUS_CHAR_UUID,
        NIMBLE_PROPERTY::NOTIFY
    );

    pService->start();

    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setMinInterval(0x20);
    pAdvertising->setMaxInterval(0x40);
    pAdvertising->setName("Titrinator-00000");

    NimBLEAdvertisementData scanResponse;
    scanResponse.setName("Titrinator-00000");
    pAdvertising->setScanResponseData(scanResponse);

    pAdvertising->start();

    Serial.println("Titrinator-00000 ready");
}

// ── Loop ──────────────────────────────────────────────────────────
void loop() {
    // USB serial
    while (Serial.available()) {
        char c = Serial.read();
        if (c == '\n') {
            handleCommand(serialBuffer);
            serialBuffer = "";
        } else if (c != '\r') {
            serialBuffer += c;
        }
    }

    delay(10);
}