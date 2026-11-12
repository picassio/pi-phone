import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const android = new URL("../android/app/src/main/", import.meta.url);

// PP-505: HyperOS refuses a foreground service's notification whose custom view inflates under its minimum height
// (BadForegroundServiceNotificationException, "inflated notification does not meet minimum height requirement"), and the
// service dies with it. The board's layout keeps 72dp at least, whatever rows it shows.
test("the progress board's custom view is at least 72dp tall, so HyperOS keeps the pi notification", async () => {
    const layout = await readFile(new URL("res/layout/progress_rows.xml", android), "utf8");
    const root = /<LinearLayout\b[^>]*>/.exec(layout.replace(/<!--[\s\S]*?-->/g, ""))?.[0] ?? "";
    const height = /android:minHeight="(\d+)dp"/.exec(root);

    assert.ok(height !== null, `the layout's root has no android:minHeight: ${root}`);
    assert.ok(Number(height[1]) >= 72, `the layout's root is only ${height[1]}dp at least`);
});

// One session or none takes the standard template: no custom view for HyperOS to measure (ProgressLayout.java, its
// JUnit test in android/app/src/test, run by CI's testDebugUnitTest).
test("the board's custom view is set only when ProgressLayout says so", async () => {
    const progress = await readFile(new URL("java/io/piphone/Progress.java", android), "utf8");

    assert.match(progress, /if \(ProgressLayout\.customBoard\(rows\.length\(\)\)\) \{\s*builder\.setStyle\(new Notification\.DecoratedCustomViewStyle\(\)\)\.setCustomBigContentView\(big\);/);
    assert.equal(progress.match(/setCustomBigContentView|setCustomContentView/g)?.length, 1);
});
