import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffBlock } from "../src/components/DiffBlock";

describe("DiffBlock", () => {
  it("renders parsed diff content and side-by-side headings", () => {
    render(
      <DiffBlock
        changes={[
          {
            path: "/tmp/project/src/App.tsx",
            kind: { type: "modify" },
            diff: [
              "diff --git a/src/App.tsx b/src/App.tsx",
              "--- a/src/App.tsx",
              "+++ b/src/App.tsx",
              "@@ -1,2 +1,2 @@",
              "-const value = 1;",
              "+const value = 2;",
              " export default value;",
            ].join("\n"),
          },
        ]}
      />,
    );

    expect(screen.getByText("App.tsx")).toBeTruthy();
    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    expect(screen.getAllByText("const value = 1;").length).toBeGreaterThan(0);
    expect(screen.getAllByText("const value = 2;").length).toBeGreaterThan(0);
    expect(screen.getAllByText("@@ -1,2 +1,2 @@").length).toBeGreaterThan(0);
  });
});
