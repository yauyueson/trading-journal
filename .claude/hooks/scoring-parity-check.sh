#!/bin/bash
# PostToolUse hook: run scoring parity tests when oss-core.ts or scoring.cjs is edited
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only trigger for scoring files
case "$FILE_PATH" in
  *oss-core.ts|*scoring.cjs)
    ;;
  *)
    exit 0
    ;;
esac

cd "$(echo "$INPUT" | jq -r '.cwd')"
RESULT=$(npx vitest run tests/scoring-parity.test.ts 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Scoring parity tests FAILED. oss-core.ts and scoring.cjs are out of sync." >&2
  echo "$RESULT" | tail -20 >&2
  exit 2
fi

echo '{"additionalContext": "Scoring parity tests passed (307 tests). oss-core.ts and scoring.cjs are in sync."}'
exit 0
