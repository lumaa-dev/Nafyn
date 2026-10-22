// UPC/EAN and ISRC validation. A code that fails here is ignored by the search (and logged), never an error:
// a typo in a barcode must not turn a perfectly good title + artist search into a failure.

export interface CodeCheck<T = string> {
    value: T | null,
    reason?: string
}

/** GS1 check digit: weights 3,1,3,1... applied from the digit left of the check digit, going left. */
export function hasValidGtinCheckDigit(digits: string): boolean {
    if (!/^\d+$/.test(digits) || digits.length < 2) return false;
    const body = digits.slice(0, -1);
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
        const digit = Number(body[body.length - 1 - i]);
        sum += digit * (i % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** UPC-A (12 digits) or EAN-13 (13 digits) with a valid check digit. Spaces and hyphens are tolerated. */
export function parseUpc(input: unknown): CodeCheck {
    if (typeof input !== "string" || input.trim() === "") return { value: null, reason: "empty" };
    const digits = input.replace(/[\s-]/g, "");
    if (!/^\d+$/.test(digits)) return { value: null, reason: "not numeric" };
    if (digits.length !== 12 && digits.length !== 13) return { value: null, reason: `${digits.length} digits, expected 12 or 13` };
    if (!hasValidGtinCheckDigit(digits)) return { value: null, reason: "bad check digit" };
    return { value: digits };
}

/** The forms a barcode is stored under on MusicBrainz: a UPC-A is also an EAN-13 with a leading zero. */
export function barcodeForms(code: string): string[] {
    return code.length === 12 ? [code, `0${code}`] : code.startsWith("0") ? [code.slice(1), code] : [code];
}

export function sameBarcode(a: string | null | undefined, b: string): boolean {
    if (!a) return false;
    const digits = a.replace(/\D/g, "");
    return barcodeForms(b).includes(digits) || barcodeForms(digits).includes(b);
}

// country code (2 letters) + registrant (3 alphanumerics) + year (2 digits) + designation (5 digits)
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/;

/** ISRC with the optional hyphens removed and upper-cased. */
export function parseIsrc(input: unknown): CodeCheck {
    if (typeof input !== "string" || input.trim() === "") return { value: null, reason: "empty" };
    const compact = input.replace(/[\s-]/g, "").toUpperCase();
    if (compact.length !== 12) return { value: null, reason: `${compact.length} characters, expected 12` };
    if (!ISRC_PATTERN.test(compact)) return { value: null, reason: "not CC-XXX-YY-NNNNN" };
    return { value: compact };
}
