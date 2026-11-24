// National BBAN formats: SWIFT IBAN Registry, release 103 (September 2026).
// https://www.swift.com/sites/default/files/files/iban-registry_4.pdf
const formats = {
    AD: '4n4n12c',
    AE: '3n16n',
    AL: '8n16c',
    AT: '5n11n',
    AZ: '4a20c',
    BA: '3n3n8n2n',
    BE: '3n7n2n',
    BG: '4a4n2n8c',
    BH: '4a14c',
    BI: '5n5n11n2n',
    BR: '8c5n10n1c1c',
    BY: '4c4n16c',
    CH: '5n12c',
    CR: '4n14n',
    CY: '3n5n16c',
    CZ: '4n16n',
    DE: '8n10n',
    DJ: '5n5n11n2n',
    DK: '4n9n1n',
    DO: '4c20n',
    EE: '2n14n',
    EG: '4n4n17n',
    ES: '4n4n1n1n10n',
    FI: '3n11n',
    FK: '2a12n',
    FO: '4n9n1n',
    FR: '5n5n11c2n',
    GB: '4a6n8n',
    GE: '2a16n',
    GI: '4a15c',
    GL: '4n9n1n',
    GR: '3n4n16c',
    GT: '4c20c',
    HN: '4a20n',
    HR: '7n10n',
    HU: '3n4n1n15n1n',
    IE: '4a6n8n',
    IL: '3n3n13n',
    IQ: '4a3n12n',
    IS: '4n2n6n10n',
    IT: '1a5n5n12c',
    JO: '4a4n18c',
    KW: '4a22c',
    KZ: '3n13c',
    LB: '4n20c',
    LC: '4a24c',
    LI: '5n12c',
    LT: '5n11n',
    LU: '3n13c',
    LV: '4a13c',
    LY: '3n3n15n',
    MC: '5n5n11c2n',
    MD: '2c18c',
    ME: '3n13n2n',
    MK: '3n10c2n',
    MN: '4n12n',
    MR: '5n5n11n2n',
    MT: '4a5n18c',
    MU: '4a2n2n12n3n3a',
    NI: '4a20n',
    NL: '4a10n',
    NO: '4n6n1n',
    OM: '3n16c',
    PK: '4a16c',
    PL: '8n16n',
    PS: '4a21c',
    PT: '4n4n11n2n',
    QA: '4a21c',
    RO: '4a16c',
    RS: '3n13n2n',
    RU: '9n5n15c',
    SA: '2n18c',
    SC: '4a2n2n16n3a',
    SD: '2n12n',
    SE: '3n16n1n',
    SI: '5n8n2n',
    SK: '4n6n10n',
    SM: '1a5n5n12c',
    SO: '4n3n12n',
    ST: '4n4n11n2n',
    SV: '4a20n',
    TL: '3n14n2n',
    TN: '2n3n13n2n',
    TR: '5n1n16c',
    UA: '6n19c',
    VA: '3n15n',
    VG: '4a16n',
    XK: '4n10n2n',
    YE: '4a4n18c',
};
const patterns = Object.fromEntries(Object.entries(formats).map(([country, format]) => [country,
    new RegExp('^' + [...format.matchAll(/(\d+)([anc])/g)].map(([, length, type]) =>
        ({ a: '[A-Z]', n: '[0-9]', c: '[A-Z0-9]' }[type]) + '{' + length + '}').join('') + '$')]));

export function normalizeIban(value) {
    return String(value).replace(/\s/g, '').toUpperCase();
}

export function validateIban(value) {
    const iban = normalizeIban(value);
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
        throw new Error('Enter an IBAN with a country code, two check digits and letters or numbers only.');
    }
    const country = iban.slice(0, 2);
    if (!Object.hasOwn(formats, country)) throw new Error('This country code is not in the supported IBAN registry.');
    const length = 4 + [...formats[country].matchAll(/(\d+)[anc]/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    if (iban.length !== length) throw new Error(`An IBAN for ${country} must contain ${length} characters.`);
    if (!patterns[country].test(iban.slice(4))) throw new Error('Check the letters and numbers in this country’s IBAN format.');
    let remainder = 0;
    for (const char of iban.slice(4) + iban.slice(0, 4)) {
        const digits = char >= 'A' ? String(char.charCodeAt(0) - 55) : char;
        for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
    }
    if (remainder !== 1) throw new Error('The IBAN check digits do not match. Check the recipient’s IBAN.');
    return iban;
}

export function italianIbanParts(value) {
    const iban = normalizeIban(value);
    if (!/^IT[0-9]{2}[A-Z][0-9]{10}[A-Z0-9]{12}$/.test(iban)) return null;
    return [['Country', iban.slice(0, 2)], ['Check digits', iban.slice(2, 4)], ['CIN', iban.slice(4, 5)],
        ['ABI', iban.slice(5, 10)], ['CAB', iban.slice(10, 15)], ['Account number', iban.slice(15)]];
}

export function formatIban(value) {
    const iban = normalizeIban(value);
    // Preserve legacy opaque values rather than presenting them as validated IBANs.
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return String(value);
    return italianIbanParts(iban)?.map(([, part]) => part).join(' ') || iban.match(/.{1,4}/g).join(' ');
}

