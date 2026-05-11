"""Pytest configuration shared across the Python SDK tests.

Registers two Hypothesis profiles:

- ``default`` — 200 examples per property. Used for local development and
  the ``just test-python`` recipe.
- ``ci`` — 1000 examples per property. Activated by setting
  ``HYPOTHESIS_PROFILE=ci`` (e.g. on a nightly CI schedule) to exercise
  the property tests more aggressively without slowing down the
  per-commit suite.

Both profiles disable Hypothesis's deadline (Decimal arithmetic on huge
integers can momentarily exceed the default 200ms ceiling) and suppress
the ``too_slow`` / ``filter_too_much`` health checks that fire on the
``markets()`` + composite-strategy stack.
"""

from __future__ import annotations

import os

from hypothesis import HealthCheck, settings

_COMMON_KWARGS: dict = {
    "deadline": None,
    "suppress_health_check": [HealthCheck.too_slow, HealthCheck.filter_too_much],
}

settings.register_profile("default", max_examples=200, **_COMMON_KWARGS)
settings.register_profile("ci", max_examples=1000, **_COMMON_KWARGS)

settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "default"))
