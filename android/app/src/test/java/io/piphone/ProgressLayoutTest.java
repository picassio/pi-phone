package io.piphone;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** PP-505: few sessions take the standard template, so HyperOS has no custom view to measure; more take the board. */
public class ProgressLayoutTest {
    @Test
    public void noneOrOneSessionTakesTheStandardTemplate() {
        assertFalse(ProgressLayout.customBoard(0));
        assertFalse(ProgressLayout.customBoard(1));
    }

    @Test
    public void twoOrMoreSessionsTakeTheBoard() {
        assertTrue(ProgressLayout.customBoard(2));
        assertTrue(ProgressLayout.customBoard(5));
    }
}
