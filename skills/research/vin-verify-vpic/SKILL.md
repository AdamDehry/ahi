---
name: vin-verify-vpic
description: Verify or repair a VIN for free — the check digit (49 CFR 565.15), one-swap look-alike repair for OCR misreads (B/8, S/5, G/6, Z/2, D/0), and confirming a candidate on NHTSA vPIC (keyless) by its ErrorCode. Use when an OCR'd or typed VIN fails its check digit, when two VINs look alike, or before trusting a VIN that came off a photo. For full year/make/model/trim or market data use a commercial decoder.
version: 1.1.0
category: research
private: false
last_verified: 2026-11-05
verified_by: tzali
---

# vin-verify-vpic

A VIN that fails its check digit is almost always one misread character; fix it with one look-alike swap, and let NHTSA vPIC pick between the swaps that pass.

## When to use

- An OCR'd VIN (windshield, door sticker photo, paper) fails its check digit.
- A typed VIN fails and you want the likely intended one to show staff.
- You need a free, keyless "is this a real VIN that decodes" answer.

## When NOT to use

- Year/make/model/trim to fill a record, or market listings → a commercial decoder.
- A VIN that already passes its check digit: do not "repair" it.

## Workflow

1. **Clean**: uppercase, drop spaces and dashes; O/Q→0, I→1 (VINs never contain I, O, Q).
2. **Check digit** (position 9): transliterate letters (A1 B2 C3 D4 E5 F6 G7 H8 J1 K2 L3 M4 N5 P7 R9 S2 T3 U4 V5 W6 X7 Y8 Z9), weights `8 7 6 5 4 3 2 10 0 9 8 7 6 5 4 3 2`, sum mod 11, 10 = `X`.
3. **If it fails, try ONE swap at a time** from the look-alike pairs B↔8, S↔5, G↔6, Z↔2, D↔0. Keep swaps that pass the check digit and keep the last four as digits. Expect more than one: one wrong swap in eleven passes by accident.
4. **Confirm each survivor on vPIC**: `GET https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/<VIN>?format=json` (no key). Read `Results[0].ErrorCode`:
   - `"0"` with Make and Model filled → decodes clean. That is a pass.
   - `"8"` (no detailed data), `"1"` (check digit), `"1,3,14"` and similar → not a pass.
   - Network error or non-200 → unknown. Treat it as neither a pass nor a fail.
5. **Decide**: exactly one clean decode → offer it **for human review** (never write it as the confirmed VIN). None, several, more than ~6 candidates, or vPIC unreachable → flag for a person.

## Gotchas

- Worked case (synthetic, same shape as a real one): `1ZXYG1A78S8000100` (B at position 11 read as 8) has TWO check-digit-valid swaps: `1ZXYG1A78SB000100` (the true VIN) and `1ZXY61A78S8000100` (G→6). On the real case vPIC answered `0` for the true VIN and `8` (no model) for the decoy, so the check digit alone would have guessed wrong half the time.
- Only single swaps. Two-swap repairs multiply accidental passes, and vPIC does not validate the serial (positions 12–17), so a wrong serial still decodes clean.
- A typed or barcode VIN that passes is never second-guessed by a repair.
- vPIC is slow sometimes: time out at ~5 s and treat a timeout as unknown.

