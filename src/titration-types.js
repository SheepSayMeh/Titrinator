// Each entry defines the behaviour for one titration type.
// expectDirection: +1 = pH rises (base titrant), -1 = pH falls (acid titrant)
// Speed control (threshold, delays) is handled entirely in firmware (TIT_SPEED_GAIN etc.)
export const TITRATION_TYPES = {
    'acid-base-base': {
        label:           'Acid/Base (base titrant)',
        expectDirection:  1,
    },
    'acid-base-acid': {
        label:           'Acid/Base (acid titrant)',
        expectDirection: -1,
    },
};
