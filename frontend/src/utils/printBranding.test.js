import { A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS } from "./printBranding";

describe("compact A4 print CSS", () => {
  test("branding uses the compact logo and spacing", () => {
    expect(PRINT_BRANDING_CSS).toMatch(/max-width:\s*96px/);
    expect(PRINT_BRANDING_CSS).toMatch(/max-height:\s*58px/);
    expect(PRINT_BRANDING_CSS).toMatch(/\.print-branding\s*\{[^}]*margin:\s*0 0 4px/);
    expect(PRINT_BRANDING_CSS).toMatch(/\.printed-by\s*\{[^}]*margin:\s*8px 0 0/);
    expect(PRINT_BRANDING_CSS).not.toMatch(/max-height:\s*90px/);
  });

  test("sheet chrome is compact and paginates without forcing one page", () => {
    expect(A4_PRINT_SHEET_CSS).toMatch(/@page\s*\{\s*margin:\s*9mm;/);
    expect(A4_PRINT_SHEET_CSS).toMatch(/font-size:\s*10\.5pt/);
    expect(A4_PRINT_SHEET_CSS).toMatch(/padding:\s*2px 4px/);
    expect(A4_PRINT_SHEET_CSS).toMatch(/thead\s*\{\s*display:\s*table-header-group/);
    expect(A4_PRINT_SHEET_CSS).toMatch(/tbody tr\s*\{\s*page-break-inside:\s*avoid/);
    expect(A4_PRINT_SHEET_CSS).toMatch(/table\s*\{[^}]*page-break-inside:\s*auto/);
    expect(A4_PRINT_SHEET_CSS).not.toMatch(/page-break-(?:before|after)\s*:\s*always/);
    expect(A4_PRINT_SHEET_CSS).not.toMatch(/min-height\s*:\s*100(?:vh|%)/);
  });
});
