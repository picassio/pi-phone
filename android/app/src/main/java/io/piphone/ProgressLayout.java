package io.piphone;

/**
 * Which template the pi notification's progress board takes (PP-505), apart from Android so a unit test can hold it.
 * One session or none fits the standard template (the counts as its title, the session's line as its text); the custom
 * board of rows (res/layout/progress_rows.xml) is for two or more. A custom view is where HyperOS measures a minimum
 * height and refuses a foreground service's notification under it, so the common case does without one.
 *
 * Right after an update the custom board waits too (PP-553): the system UI can still hold the app's resources from the
 * APK that was replaced, fail to inflate progress_rows ("Resources$NotFoundException: Resource ID #0x7f070007"), and
 * Android then kills the app for a bad foreground-service notification, again on each restart. The standard template
 * needs none of the app's layouts.
 */
final class ProgressLayout {
    /** The fewest rows that get the custom board. */
    static final int BOARD_FROM_ROWS = 2;
    /** How long after an install or update the board keeps to the standard template. */
    static final long SETTLE_AFTER_UPDATE_MS = 10 * 60 * 1000;

    private ProgressLayout() {}

    /**
     * Whether `rows` sessions are shown as the custom board, not the standard template, `sinceUpdateMs` after the app was
     * installed or updated.
     */
    static boolean customBoard(int rows, long sinceUpdateMs) {
        return rows >= BOARD_FROM_ROWS && sinceUpdateMs >= SETTLE_AFTER_UPDATE_MS;
    }
}
