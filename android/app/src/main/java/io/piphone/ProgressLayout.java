package io.piphone;

/**
 * Which template the pi notification's progress board takes (PP-505), apart from Android so a unit test can hold it.
 * One session or none fits the standard template (the counts as its title, the session's line as its text); the custom
 * board of rows (res/layout/progress_rows.xml) is for two or more. A custom view is where HyperOS measures a minimum
 * height and refuses a foreground service's notification under it, so the common case does without one.
 */
final class ProgressLayout {
    /** The fewest rows that get the custom board. */
    static final int BOARD_FROM_ROWS = 2;

    private ProgressLayout() {}

    /** Whether `rows` sessions are shown as the custom board, not the standard template. */
    static boolean customBoard(int rows) {
        return rows >= BOARD_FROM_ROWS;
    }
}
