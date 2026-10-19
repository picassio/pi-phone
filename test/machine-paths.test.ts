import assert from "node:assert/strict";
import { test } from "node:test";
import { machinePaths } from "../src/server/machine-paths.ts";

test("a Windows machine's paths are drive paths with forward slashes", () => {
    const paths = machinePaths({ platform: "windows" });

    assert.equal(paths.normal("C:\\Users\\tuan\\proj"), "C:/Users/tuan/proj");
    assert.equal(paths.resolve("C:/Users/tuan", "proj\\src"), "C:/Users/tuan/proj/src");
    assert.equal(paths.resolve("C:/Users/tuan", "D:/work"), "D:/work");
    assert.equal(paths.resolve("C:/Users/tuan", ".."), "C:/Users");
    assert.equal(paths.join("C:/Users/tuan", "a.txt"), "C:/Users/tuan/a.txt");
    assert.equal(paths.dirname("C:/Users/tuan"), "C:/Users");
    assert.equal(paths.dirname("C:/"), "C:/", "a drive's root has no parent");
    assert.equal(paths.basename("C:\\Users\\tuan\\a.txt"), "a.txt");
    assert.ok(paths.isAbsolute("C:/x") && paths.isAbsolute("c:\\x") && paths.isAbsolute("//server/share"));
    assert.ok(!paths.isAbsolute("/x") && !paths.isAbsolute("x") && !paths.isAbsolute("C:x"), "drive-relative is not absolute");
    assert.equal(paths.expandHome("~", "C:/Users/tuan"), "C:/Users/tuan");
    assert.equal(paths.expandHome("~/proj", "C:/Users/tuan"), "C:/Users/tuan/proj");
    assert.equal(paths.expandHome("~\\proj\\a", "C:/Users/tuan"), "C:/Users/tuan/proj/a");
    assert.ok(paths.within("C:/Users/tuan/proj", "c:/users/TUAN/proj/a.txt"), "letters in either case");
    assert.ok(paths.within("C:/Users/tuan/proj", "C:/Users/tuan/proj"));
    assert.ok(!paths.within("C:/Users/tuan/proj", "C:/Users/tuan/project"));
    assert.ok(!paths.within("C:/Users/tuan/proj", "C:/Users/tuan/projx"));
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
