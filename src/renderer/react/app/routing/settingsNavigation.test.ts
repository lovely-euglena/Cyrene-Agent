import { describe, expect, it } from "vitest";
import { resolveSettingsDestination } from "./settingsNavigation";

describe("resolveSettingsDestination", () => {
  it("routes legacy settings sections to their React workspace equivalents", () => {
    expect(resolveSettingsDestination("api")).toEqual({ kind: "settings", section: "models" });
    expect(resolveSettingsDestination("api-advanced")).toEqual({ kind: "settings", section: "models" });
    expect(resolveSettingsDestination("tokens")).toEqual({ kind: "settings", section: "usage" });
    expect(resolveSettingsDestination("plugins")).toEqual({ kind: "settings", section: "tools" });
  });

  it("routes fork-only sections (user/about/portable/cache/runtime) to 常规/模型", () => {
    expect(resolveSettingsDestination("user")).toEqual({ kind: "settings", section: "general" });
    expect(resolveSettingsDestination("about")).toEqual({ kind: "settings", section: "general" });
    expect(resolveSettingsDestination("portable")).toEqual({ kind: "settings", section: "general" });
    expect(resolveSettingsDestination("cache")).toEqual({ kind: "settings", section: "general" });
    expect(resolveSettingsDestination("runtime")).toEqual({ kind: "settings", section: "models" });
  });

  it("routes the removed schedule window to the workspace task panel", () => {
    expect(resolveSettingsDestination("tasks")).toEqual({ kind: "scheduledTasks" });
  });

  it("opens migrated music settings from the music player entry", () => {
    expect(resolveSettingsDestination("music")).toEqual({ kind: "settings", section: "preferences" });
  });

  it("defaults unknown legacy sections to appearance", () => {
    expect(resolveSettingsDestination("missing-section")).toEqual({ kind: "settings", section: "appearance" });
  });
});
