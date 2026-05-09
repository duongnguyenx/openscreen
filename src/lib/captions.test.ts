import { describe, expect, it } from "vitest";
import { getCaptionStyle } from "./captions";

describe("getCaptionStyle", () => {
	it("returns bold white/dark style for tiktok", () => {
		const s = getCaptionStyle("tiktok");
		expect(s.fontWeight).toBe("bold");
		expect(s.color).toBe("#ffffff");
		expect(s.fontSize).toBeGreaterThan(30);
		expect(s.backgroundColor).toContain("rgba");
	});

	it("returns smaller, opaque style for youtube", () => {
		const s = getCaptionStyle("youtube");
		expect(s.fontWeight).toBe("normal");
		expect(s.fontSize).toBeLessThan(36);
		expect(s.backgroundColor).toContain("rgba");
	});

	it("returns transparent italic style for subtle", () => {
		const s = getCaptionStyle("subtle");
		expect(s.fontStyle).toBe("italic");
		expect(s.backgroundColor).toBe("transparent");
	});

	it("center-aligns all caption presets", () => {
		for (const preset of ["tiktok", "youtube", "subtle"] as const) {
			expect(getCaptionStyle(preset).textAlign).toBe("center");
		}
	});
});
