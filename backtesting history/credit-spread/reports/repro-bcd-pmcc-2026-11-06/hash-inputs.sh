#!/bin/zsh
# usage: hash-inputs.sh <label>
M=/Users/yuchenqiu/03_Projects/trading-journal
OUT=$(dirname $0)/inputs-$1.txt
cd $M
{
echo "# $1 $(date -u +%FT%TZ)"
for f in scripts/autoresearch/data-cache.json data/intraday-candles.sqlite data/option-chains.sqlite data/attempts-global.json config/dataset-manifest.json config/adoption-gates.json; do
  echo "$(shasum -a 256 $f | cut -d' ' -f1)  $(stat -f '%m %z' $f)  $f"
done
echo "trial-ledger-dir: $(ls data/trial-ledger | sort | xargs -I{} shasum -a 256 data/trial-ledger/{} | shasum -a 256 | cut -d' ' -f1) files=$(ls data/trial-ledger | wc -l)"
echo "leaderboards: $(ls data/leaderboard-* scripts/autoresearch/leaderboard*.json | sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1) files=$(ls data/leaderboard-* scripts/autoresearch/leaderboard*.json | wc -l)"
ls -la data/trial-ledger data/leaderboard-* | md5 | sed 's/^/ls-la-md5: /'
} > $OUT
echo done $OUT
