from __future__ import annotations

import unittest

import numpy as np

from detect_laughter import (
    BATCH_PATCHES,
    PATCH_HOP_SAMPLES,
    PATCH_SAMPLES,
    Profile,
    build_events,
    complete_patch_count,
)


class EventConstructionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.profile = Profile(
            high_threshold=0.15,
            low_threshold=0.05,
            merge_gap_ms=720,
            min_duration_ms=720,
        )

    def test_builds_timestamped_event_with_contributing_labels(self) -> None:
        scores = np.zeros((8, 5), dtype=np.float32)
        scores[2:5, 0] = [0.12, 0.8, 0.2]
        scores[3, 2] = 0.3

        events = build_events(scores, 5_000, self.profile)

        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["id"], "L00001")
        self.assertEqual(event["startMs"], 960)
        self.assertEqual(event["endMs"], 3_360)
        self.assertGreaterEqual(event["peakMs"], event["startMs"])
        self.assertLessEqual(event["peakMs"], event["endMs"])
        self.assertEqual(
            [label["name"] for label in event["labels"]],
            ["Laughter", "Snicker"],
        )

    def test_merges_nearby_candidates_and_bounds_recording_end(self) -> None:
        scores = np.zeros((10, 5), dtype=np.float32)
        scores[2, 0] = 0.8
        scores[6, 1] = 0.7

        events = build_events(scores, 3_500, self.profile)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["endMs"], 3_500)

    def test_rejects_scores_with_wrong_shape(self) -> None:
        with self.assertRaisesRegex(ValueError, "score column"):
            build_events(np.zeros((3, 4), dtype=np.float32), 2_000, self.profile)

    def test_nonfinal_batch_excludes_model_padding_frame(self) -> None:
        sample_count = PATCH_SAMPLES + (BATCH_PATCHES - 1) * PATCH_HOP_SAMPLES
        self.assertEqual(complete_patch_count(sample_count), BATCH_PATCHES)


if __name__ == "__main__":
    unittest.main()
