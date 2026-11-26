import assert from "node:assert/strict";
import { test } from "node:test";
import { machinePaths } from "../src/server/machine-paths.ts";

test("a Windows machine's paths are drive paths with forward slashes", () => {
    const paths = machinePaths({ platform: "windows" });

    assert.equal(paths.normal("C:\\Users\\me\\proj"), "C:/Users/me/proj");
    assert.equal(paths.resolve("C:/Users/me", "proj\\src"), "C:/Users/me/proj/src");
    assert.equal(paths.resolve("C:/Users/me", "D:/work"), "D:/work");
    assert.equal(paths.resolve("C:/Users/me", ".."), "C:/Users");
    assert.equal(paths.join("C:/Users/me", "a.txt"), "C:/Users/me/a.txt");
    assert.equal(paths.dirname("C:/Users/me"), "C:/Users");
    assert.equal(paths.dirname("C:/"), "C:/", "a drive's root has no parent");
    assert.equal(paths.basename("C:\\Users\\me\\a.txt"), "a.txt");
    assert.ok(paths.isAbsolute("C:/x") && paths.isAbsolute("c:\\x") && paths.isAbsolute("//server/share"));
    assert.ok(!paths.isAbsolute("/x") && !paths.isAbsolute("x") && !paths.isAbsolute("C:x"), "drive-relative is not absolute");
    assert.equal(paths.expandHome("~", "C:/Users/me"), "C:/Users/me");
    assert.equal(paths.expandHome("~/proj", "C:/Users/me"), "C:/Users/me/proj");
    assert.equal(paths.expandHome("~\\proj\\a", "C:/Users/me"), "C:/Users/me/proj/a");
    assert.ok(paths.within("C:/Users/me/proj", "c:/users/ME/proj/a.txt"), "letters in either case");
    assert.ok(paths.within("C:/Users/me/proj", "C:/Users/me/proj"));
    assert.ok(!paths.within("C:/Users/me/proj", "C:/Users/me/project"));
    assert.ok(!paths.within("C:/Users/me/proj", "C:/Users/me/projx"));
    assert.equal(paths.onDrive("/", "C:/Users/me"), "C:/", "the root is the home's drive's");
    assert.equal(paths.onDrive("\\$Recycle.Bin", "D:/home"), "D:/$Recycle.Bin");
    assert.equal(paths.onDrive("E:/x", "C:/Users/me"), "E:/x");
    assert.equal(paths.onDrive("//server/share", "C:/Users/me"), "//server/share");
});

test("POSIX machines, and machines not yet connected, keep their paths as they are", () => {
    for (const paths of [machinePaths({ platform: "linux" }), machinePaths(undefined)]) {
        assert.equal(paths.windows, false);
        assert.equal(paths.normal("/home/a\\b"), "/home/a\\b", "a backslash is a letter in a POSIX name");
        assert.equal(paths.resolve("/home/u", "../x"), "/home/x");
        assert.equal(paths.expandHome("~/p", "/home/u"), "/home/u/p");
        assert.equal(paths.expandHome("~x", "/home/u"), "~x");
        assert.ok(paths.within("/home/u/p", "/home/u/p/a") && !paths.within("/home/u/p", "/home/u/pp"));
        assert.ok(paths.isAbsolute("/x") && !paths.isAbsolute("C:/x"));
    }
});

test("what the folder picker hides: dot names everywhere; on Windows, its hidden and system folders where Windows puts them (PP-117)", () => {
    const windows = machinePaths({ platform: "windows" });
    const shown = (folder: string, names: string[]) => names.filter((name) => !windows.hidden(folder, name));

    // A drive's root, as laptop-01's C:/ lists it.
    assert.deepEqual(
        shown("C:/", ["$Recycle.Bin", "$WinREAgent", "Config.Msi", "Documents and Settings", "PerfLogs", "Program Files", "ProgramData", "Recovery", "System Volume Information", "Users", "Windows", ".git"]),
        ["PerfLogs", "Program Files", "Users", "Windows"],
    );
    assert.deepEqual(shown("D:", ["$RECYCLE.BIN", "System Volume Information", "Games"]), ["Games"]);
    assert.deepEqual(shown("C:/Users", ["All Users", "Default", "Default User", "Public", "tuan"]), ["Public", "tuan"]);
    assert.deepEqual(shown("C:\\Users\\me", ["AppData", "Application Data", "Cookies", "Desktop", "My Documents", "Start Menu", "Templates", "projects"]), ["Desktop", "projects"]);

    // The same names elsewhere are a person's own folders.
    assert.deepEqual(shown("C:/Users/me/projects", ["Recovery", "Templates", "Default", "Boot"]), ["Recovery", "Templates", "Default", "Boot"]);

    // POSIX hides dot names only.
    const posix = machinePaths({ platform: "linux" });

    assert.deepEqual([".cache", "$x", "Recovery"].filter((name) => !posix.hidden("/", name)), ["$x", "Recovery"]);
});
