root := justfile_directory()
venv := root / ".venv"
ruff := venv / "bin/ruff"
mypy := venv / "bin/mypy"
pytest := venv / "bin/pytest"

# Setup development environment
setup:
    python3 -m venv {{ venv }}
    {{ venv }}/bin/pip install -e "sdks/python[dev]"
    cd sdks/typescript && npm install

# Lint all SDKs
lint: lint-python lint-typescript lint-rust

# Format all SDKs
fmt: fmt-python fmt-typescript fmt-rust

# Check formatting (CI)
fmt-check: fmt-check-python fmt-check-typescript fmt-check-rust

# Full pre-push check (format + lint)
check: fmt-check lint

# Run all unit tests
test: test-python test-typescript test-rust

# Build documentation for all SDKs
docs: docs-python docs-typescript docs-rust

# Build Python SDK documentation
docs-python:
    cd sdks/python && python -m sphinx -W --keep-going -b html docs docs/_build

# Build TypeScript SDK documentation
docs-typescript:
    cd sdks/typescript && npx typedoc

# Build Rust SDK documentation
docs-rust:
    cd sdks/rust && cargo doc --no-deps --document-private-items

# Run integration tests (one SDK at a time to avoid overwhelming testnet)
integration sdk:
    just integration-{{ sdk }}

# --- Python ---
lint-python:
    cd sdks/python && {{ ruff }} check src tests examples && {{ mypy }} src/o2_sdk

fmt-python:
    cd sdks/python && {{ ruff }} format src tests examples

fmt-check-python:
    cd sdks/python && {{ ruff }} format --check src tests examples

test-python:
    cd sdks/python && {{ pytest }} tests/ -m "not integration" -v

integration-python:
    cd sdks/python && {{ pytest }} tests/test_integration.py -m integration -v --timeout=600

# --- TypeScript ---
lint-typescript:
    cd sdks/typescript && npx @biomejs/biome check src tests examples && npx tsc --noEmit

fmt-typescript:
    cd sdks/typescript && npx @biomejs/biome format --write src tests examples

fmt-check-typescript:
    cd sdks/typescript && npx @biomejs/biome ci --linter-enabled=false --assist-enabled=false src tests examples

test-typescript:
    cd sdks/typescript && npx vitest run

integration-typescript:
    cd sdks/typescript && O2_INTEGRATION=1 npx vitest run tests/integration.test.ts

# --- Rust ---
lint-rust:
    cd sdks/rust && cargo clippy --all-features -- -D warnings

fmt-rust:
    cd sdks/rust && cargo fmt --all

fmt-check-rust:
    cd sdks/rust && cargo fmt --all --check

test-rust:
    cd sdks/rust && cargo test --all-features

integration-rust:
    cd sdks/rust && cargo test --features integration --test integration_tests -- --test-threads=1
