import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, parseSettings } from "./settings.ts";

test("missing keys take defaults", () => {
	assert.deepEqual(parseSettings("{}"), DEFAULT_SETTINGS);
	assert.deepEqual(parseSettings('{"claudeCodeBilling":{"enabled":false}}').claudeCodeBilling, {
		enabled: false,
		version: DEFAULT_SETTINGS.claudeCodeBilling.version,
	});
});

test("unknown keys and wrong types are errors", () => {
	assert.throws(() => parseSettings('{"foo":1}'), /Unknown setting "foo"/);
	assert.throws(() => parseSettings('{"claudeCodeBilling":{"nope":1}}'), /claudeCodeBilling\.nope/);
	assert.throws(() => parseSettings('{"claudeCodeBilling":{"enabled":"yes"}}'), /boolean/);
});
