import { describe, expect, it } from "vitest";
import {
  FileReadQuerySchema,
  FilesystemEntriesReadQuerySchema,
  WorkspaceGitDiffQuerySchema,
  WorkspaceGitStatusQuerySchema,
  parseQuery,
} from "../src/http-schemas.js";

describe("workspace query schemas", () => {
  it("validates filesystem entries query with optional path", () => {
    const emptyPath = parseQuery(FilesystemEntriesReadQuerySchema, {});
    expect(emptyPath.path).toBeUndefined();

    const withPath = parseQuery(FilesystemEntriesReadQuerySchema, {
      path: "/data/code/farfield",
    });
    expect(withPath.path).toBe("/data/code/farfield");
  });

  it("rejects unknown keys for filesystem entries query", () => {
    expect(() =>
      parseQuery(FilesystemEntriesReadQuerySchema, {
        path: "/tmp/repo",
        extra: "nope",
      }),
    ).toThrowError(/Unrecognized key/);
  });

  it("requires file read path", () => {
    const parsed = parseQuery(FileReadQuerySchema, {
      path: "/tmp/repo/src/index.ts",
    });
    expect(parsed.path).toBe("/tmp/repo/src/index.ts");

    expect(() => parseQuery(FileReadQuerySchema, {})).toThrowError(/Required/);
  });

  it("requires git status cwd", () => {
    const parsed = parseQuery(WorkspaceGitStatusQuerySchema, {
      cwd: "/tmp/repo",
    });
    expect(parsed.cwd).toBe("/tmp/repo");

    expect(() => parseQuery(WorkspaceGitStatusQuerySchema, {})).toThrowError(
      /Required/,
    );
  });

  it("requires git diff cwd and path", () => {
    const parsed = parseQuery(WorkspaceGitDiffQuerySchema, {
      cwd: "/tmp/repo",
      path: "/tmp/repo/src/index.ts",
    });
    expect(parsed.cwd).toBe("/tmp/repo");
    expect(parsed.path).toBe("/tmp/repo/src/index.ts");

    expect(() => parseQuery(WorkspaceGitDiffQuerySchema, { cwd: "/tmp/repo" }))
      .toThrowError(/Required/);
  });
});
