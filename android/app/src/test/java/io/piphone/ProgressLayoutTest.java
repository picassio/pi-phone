package io.piphone;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * PP-505: few sessions take the standard template, so HyperOS has no custom view to measure; more take the board.
 * PP-553: right after an update none take the board, so a system UI still holding the replaced APK has nothing to inflate.
 */
public class ProgressLayoutTest {
    private static final long SETTLED = ProgressLayout.SETTLE_AFTER_UPDATE_MS;

    @Test
    public void noneOrOneSessionTakesTheStandardTemplate() {
        assertFalse(ProgressLayout.customBoard(0, SETTLED));
        assertFalse(ProgressLayout.customBoard(1, SETTLED));
    }

    @Test
    public void twoOrMoreSessionsTakeTheBoard() {
        assertTrue(ProgressLayout.customBoard(2, SETTLED));
        assertTrue(ProgressLayout.customBoard(5, SETTLED + 1));
    }

    @Test
    public void rightAfterAnUpdateNoneTakeTheBoard() {
        assertFalse(ProgressLayout.customBoard(5, 0));
        assertFalse(ProgressLayout.customBoard(5, 90_000));
        assertFalse(ProgressLayout.customBoard(5, SETTLED - 1));
    }
}
