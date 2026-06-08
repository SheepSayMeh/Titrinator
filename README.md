**Titrinator**  
Automatic titration system built on an ESP32, controlled through a browser via the [Web Bluetooth API.](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API "https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API") 
The web frontend communicates wirelessly with the ESP32 to drive a peristaltic pump, read a pH probe, and record titration curves in real time.
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OQQmAABRAsSeYxZw/lVeDGMACBrCCNxG2BFtmZquOAAD4i3Ot7mr/egIAwGvXA6fOBdd+dKAKAAAAAElFTkSuQmCC)  
**Architecture**  
┌─────────────────────────────┐        BLE         ┌──────────────────────────┐  
 │  Browser (Chrome / Bluefy)  │ ◄────────────────► │  ESP32 firmware          │  
 │  Vite + Vanilla JS           │                    │  pH probe (ADC)          │  
 │  uPlot (charting)            │                    │  Stepper pump driver     │  
 │  jszip (export)              │                    │  Flash storage           │  
 └─────────────────────────────┘                    └──────────────────────────┘  
   
The browser is the only interface; no app install, no server, no USB connection required during operation. The ESP32 firmware stores titration records internally and streams live pH and volume data over BLE.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANElEQVR4nO3OMQ0AIAwAwZIgBKnVgjN8dGDBABMhuZt+/JaZIyJmAADwi9VP1NMNAABu1AaU3AUhiyfJeAAAAABJRU5ErkJggg==)  
**Hardware**  
| | |  
|-|-|  
| **Component** | **Notes** |   
| ESP32 module | Any variant with BLE; WROOM-32 confirmed working |   
| pH probe + signal board | Analog output to ESP32 ADC |   
| Stepper motor + driver | Drives the peristaltic pump |   
| Peristaltic pump | Tubing and fittings for reagent delivery |   
| Power supply | Sized to stepper current draw |   
   
***Note:*** * Exact pin assignments and signal conditioning circuit are defined in the firmware. Refer to * *firmware/* * for schematic details.*  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNhwgJWEPcbJpnRgQU2QtIq6DIze3UGAMBf3Gu1VcfXEwAAXrseaIkEMIPgIvAAAAAASUVORK5CYII=)  
**Repository Structure**  
firmware/        ESP32 firmware (C++, PlatformIO)  
 src/             Web frontend JavaScript  
 public/          Static assets  
 index.html       Single-page app entry point  
 vite.config.js   Build configuration  
 package.json     JS dependencies and scripts  
   
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OQQmAABRAsSfYxZo/jVEMYQLPJrCCNxG2BFtmZquOAAD4i3Ot7mr/egIAwGvXA4rLBc059ysnAAAAAElFTkSuQmCC)  
**Browser Requirements**  
Web Bluetooth requires:  
- **Chrome** on Android or desktop (Linux, macOS, Windows)  
- **Not** supported in Firefox or Safari  
- iOS: use [Bluefy](https://apps.apple.com/app/bluefy/id1492814321 "https://apps.apple.com/app/bluefy/id1492814321")  
The page can be served locally or from GitHub Pages; either way the BLE connection runs entirely client-side.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSfYxKK/kJXEkyE8WcGbCFuCLTOzVXsAAPzFsVZ3dX4cAQDgvesB/vEF9H9odtUAAAAASUVORK5CYII=)  
**Setup**  
**Firmware**  
1. Install [PlatformIO.](https://platformio.org/ "https://platformio.org/")  
2. Open the firmware/ folder as a project.  
3. Adjust pin definitions for your hardware.  
4. Flash to the ESP32:  
5. pio run --target upload  
   
**Web App**  
   
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSd40A5GMORPYEt7WMGbCFuCLTNzVFcAAPzFvVZbdX49AQDgtf0BSrIDUgOg4eAAAAAASUVORK5CYII=)  
**Usage**  
**First time**  
1. Open the app in a supported browser.  
2. Press **Scan for Devices** and pair with the ESP32.  
3. Go to **Calibrate → Pump**:  
  - Flush the tubing to remove air.  
  - Run the 50 000-step calibration routine, weigh the collected water, enter the mass. The firmware stores steps-per-mL.  
4. Go to **Calibrate → pH Probe**:  
  - Select 2-point or 3-point calibration.  
  - Submerge the probe in each buffer solution, wait for the live voltage reading to stabilise, and confirm each point.  
  - A linearity deviation indicator flags non-ideal probe behaviour.  
**Running a titration**  
1. From the home screen, select **Titrate** (enabled only after both calibrations are complete).  
2. Choose the titration type and set the total volume (mL).  
3. Place the probe and pump outlet in the analyte vessel.  
4. Press **Start**.  
During titration:  
- Live pH and dispensed volume are displayed.  
- A pH vs. volume curve is plotted in real time.  
- Detected equivalence points are listed with volume and pH.  
Press **Finish** to end and store the result, or  **Cancel** to abort.  
**Manual control**  
**Manual Control** allows stepping the pump by a set number of steps or a target volume, with selectable direction (forward/reverse) and speed (slow/normal/fast). Flush is available separately.  
**History**  
The **History** screen lists titrations stored on the ESP32's flash. A memory bar indicates storage usage. Titrations can be:  
- Viewed with the recorded curve and equivalence point table.  
- Exported as a ZIP archive via **Export (fast)** or  **Export (slow)** — the two modes likely differ in BLE transfer chunk size; use *slow* if the fast export drops packets.  
- Deleted individually or in bulk.  
**Reconnect**  
If the browser loses the BLE connection during a titration, reloading and reconnecting presents a **Resume / Interrupt** choice, allowing the titration to continue from where it left off.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OQQmAABRAsSd49m4v6wg/pwmMYQVvImwJtszMXp0BAPAX91pt1fH1BACA164Hoq8EQMMPmF8AAAAASUVORK5CYII=)  
**Dependencies**  
| | | |  
|-|-|-|  
| **Package** | **Version** | **Purpose** |   
| [uPlot](https://github.com/leeoniya/uPlot "https://github.com/leeoniya/uPlot") | ^1.6.32 | Titration curve rendering |   
| [jszip](https://stuk.github.io/jszip/ "https://stuk.github.io/jszip/") | ^3.10.1 | History export packaging |   
| [Vite](https://vite.dev/ "https://vite.dev/") | ^8.0.0 | Build tooling |   
| [gh-pages](https://github.com/tschaub/gh-pages "https://github.com/tschaub/gh-pages") | ^6.3.0 | GitHub Pages deployment |   
   
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANklEQVR4nO3OYQ1AABSAwc8mi5wvkwZyCKCAACr4Z7a7BLfMzFYdAQDwF+da3dX+9QQAgNeuB6feBdUJcyS2AAAAAElFTkSuQmCC)  
**Limitations**  
- Web Bluetooth is not available in all browsers; see [browser compatibility.](#anchor-1 "#anchor-1")  
- Temperature calibration is not yet implemented (shown as disabled in the UI).  
- Titration type definitions are firmware-side; adding new types requires a firmware change.  
- No authentication on the BLE connection; anyone in range with a compatible browser can connect.  
![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnEAAAACCAYAAAA3pIp+AAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAANUlEQVR4nO3OMQ2AABAAsSNBCUpfEJ5YGBDBgAU2QtIq6DIzW7UHAMBfHGt1V+fXEwAAXrseHDYF+yOk59sAAAAASUVORK5CYII=)  
**License**  
Copyright (c) 2026 SheepSayMeh  
