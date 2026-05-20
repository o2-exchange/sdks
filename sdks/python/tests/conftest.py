"""Pytest configuration shared across the Python SDK tests.

Registers two Hypothesis profiles:

- ``default`` — 200 examples per property. Used for local development and
  the ``just test-python`` recipe.
- ``ci`` — 1000 examples per property. Activated by setting
  ``HYPOTHESIS_PROFILE=ci`` (e.g. on a nightly CI schedule) to exercise
  the property tests more aggressively without slowing down the
  per-commit suite.

Both profiles disable Hypothesis's deadline because Decimal arithmetic on
huge integers can momentarily exceed the default 200ms ceiling, and
suppress ``too_slow`` for the same reason. ``filter_too_much`` is left
enabled so a future strategy that filters too aggressively shows up as
a test-suite signal rather than a silent slow-down.
"""

from __future__ import annotations

import os

from hypothesis import HealthCheck, settings

_COMMON_KWARGS: dict = {
    "deadline": None,
    "suppress_health_check": [HealthCheck.too_slow],
}

settings.register_profile("default", max_examples=200, **_COMMON_KWARGS)
settings.register_profile("ci", max_examples=1000, **_COMMON_KWARGS)

settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "default"))
