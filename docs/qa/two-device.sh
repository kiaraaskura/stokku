#!/usr/bin/env bash
# Captain integration QA — docs/ACCEPTANCE.md section C, two-device convergence (T-307).
#
# A "device" here is an independent sync client with its own cursor: it sees the
# tenant only through POST /v1/sync/push and GET /v1/sync/pull, never through the
# REST read endpoints. That is the property the demo depends on.
#
# Usage:  ./docs/qa/two-device.sh            (defaults to :8099)
#         API_BASE=http://host:port/v1 ./docs/qa/two-device.sh
# Needs:  curl, jq. Creates a fresh tenant per run; deletes nothing.
#
# Gate rules (sharper than "totals match"):
#   * device B's pulled sale MUST carry its line items
#   * device B's HPP breakdown MUST be non-empty and equal device A's
#     -> revenue with an empty HPP breakdown is a FAIL even when totals agree
#   * a voided sale MUST appear on device B as voided, not disappear
#   * replaying the same push batch returns duplicate for every op, totals unchanged
# Exit code = number of failed checks. Exit 90 = wrong target (not the Stokku API).

set -uo pipefail
BASE="${API_BASE:-http://127.0.0.1:8099/v1}"
HEALTH_BASE="${BASE%/v1}"
TODAY="${BUSINESS_DATE:-$(date +%F)}"
STAMP="$(date +%s)"
PASS=0; FAIL=0; FAILED=()

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); printf '  FAIL  %s\n' "$1"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1 — expected [$2] got [$3]"; fi; }
chk_num() { # label expected actual — equal as numbers, tolerate 15.0 vs 15.000
  local e="$2" a="$3"
  if [ -n "$a" ] && [ "$(awk -v x="$e" -v y="$a" 'BEGIN{print (x+0==y+0)}')" = "1" ]; then
    ok "$1 ($a)"
  else
    bad "$1 — expected [$e] got [$a]"
  fi
}

BODY=""; CODE=""
call() {
  local m=$1 p=$2 b=${3:-} t=${4:-}
  local -a args
  args=(-sS -m 30 -X "$m" -H 'Content-Type: application/json' -w '\n%{http_code}')
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "$b" ] && args+=(--data "$b")
  local raw; raw=$(curl "${args[@]}" "$BASE$p" 2>&1) || { BODY=""; CODE=000; return; }
  CODE=$(printf '%s' "$raw" | tail -n1)
  BODY=$(printf '%s' "$raw" | sed '$d')
}
row() { jq -c 'if type=="object" and has("data") then .data else . end' <<<"$1"; }
f()   { row "$1" | jq -r "$2 // empty"; }

say "0. target identity"
CODE=$(curl -sS -m 15 -o /tmp/opencode/td-health.json -w '%{http_code}' "$HEALTH_BASE/health" 2>/dev/null)
BODY=$(cat /tmp/opencode/td-health.json 2>/dev/null || true)
echo "  GET /health -> $CODE $BODY"
if [ "$CODE" != "200" ] || ! printf '%s' "$BODY" | jq -e 'has("db") and (.db|has("status"))' >/dev/null 2>&1; then
  printf '  ABORT: target is NOT the Stokku API (%s)\n' "$BASE" >&2
  exit 90
fi
ok "target is the Stokku API"
echo "  TARGET $BASE"

# --- device cursors -------------------------------------------------------
# A is the writing device. B starts at cursor 0 and must learn everything by pull.
CURSOR_A=0
CURSOR_B=0
PULLED_B=""      # accumulated raw change rows device B has seen

pull_into() { # device cursor_var file
  local cursor=$1 out=$2 limit=500 has_more=true pages=0
  : > "$out"
  while [ "$has_more" = "true" ] && [ $pages -lt 40 ]; do
    call GET "/sync/pull?cursor=$cursor&limit=$limit" "" "$TOKEN"
    if [ "$CODE" != "200" ]; then bad "GET /sync/pull -> $CODE $(row "$BODY" | head -c 150)"; return 1; fi
    row "$BODY" | jq -c '.changes[]?' >> "$out" 2>/dev/null
    local next; next=$(row "$BODY" | jq -r '.cursor // empty')
    [ -n "$next" ] && cursor=$next
    has_more=$(row "$BODY" | jq -r '.has_more // false')
    pages=$((pages+1))
  done
  printf '%s' "$cursor"
}

say "1. device A: fresh owner, item, stock in 10 @ 6.000 then 10 @ 9.000"
call POST /auth/signup "$(jq -nc --arg e "td+$STAMP@demo.test" '{email:$e,password:("Td-'"$STAMP"'-pass"),name:"TD Owner",business_name:"TD Shop '"$STAMP"'"}')"
TOKEN=$(f "$BODY" '.access_token'); OUTLET=$(f "$BODY" '.outlet.id')
[ -n "$TOKEN" ] && ok "device A signed in" || { bad "signup failed: $CODE $(row "$BODY" | head -c 200)"; exit "$FAIL"; }

call POST /items "$(jq -nc '{name:"TD Gula 1 kg",barcodes:[],base_unit:"kg",units:[{name:"kg",factor:1}],sale_price:12000,cost:0,min_stock:0,active:true}')" "$TOKEN"
chk "item created" "yes" "$([ -n "$(f "$BODY" '.id')" ] && echo yes || echo no)"
ITEM=$(f "$BODY" '.id')
call POST /stock-moves "$(jq -nc --arg i "$ITEM" --arg o "$OUTLET" --arg d "$TODAY" '{item_id:$i,outlet_id:$o,type:"in",qty_positive:10,unit_cost:6000,business_date:$d}')" "$TOKEN"
chk "stock in 10 @ 6.000" "200" "$CODE"
call POST /stock-moves "$(jq -nc --arg i "$ITEM" --arg o "$OUTLET" --arg d "$TODAY" '{item_id:$i,outlet_id:$o,type:"in",qty_positive:10,unit_cost:9000,business_date:$d}')" "$TOKEN"
chk "stock in 10 @ 9.000" "200" "$CODE"
call GET "/items/$ITEM" "" "$TOKEN"
chk "device A cost_avg is 7.500" "7500" "$(f "$BODY" '.cost_avg')"

say "2. device A: 2-line sale, cash"
call POST /items "$(jq -nc '{name:"TD Kopi sachet",barcodes:[],base_unit:"pcs",units:[{name:"pcs",factor:1}],sale_price:4000,cost:0,min_stock:0,active:true}')" "$TOKEN"
ITEM2=$(f "$BODY" '.id')
call POST /stock-moves "$(jq -nc --arg i "$ITEM2" --arg o "$OUTLET" --arg d "$TODAY" '{item_id:$i,outlet_id:$o,type:"in",qty_positive:10,unit_cost:2000,business_date:$d}')" "$TOKEN"
chk "second item stocked" "200" "$CODE"
call POST /sales "$(jq -nc --arg o "$OUTLET" --arg i "$ITEM" --arg i2 "$ITEM2" --arg d "$TODAY" '{outlet_id:$o,business_date:$d,discount:0,payment_method:"cash",paid:true,lines:[{item_id:$i,qty:5,unit_price:12000,discount:0},{item_id:$i2,qty:3,unit_price:4000,discount:0}]}')" "$TOKEN"
SALE=$(f "$BODY" '.id')
chk "2-line sale posted" "yes" "$([ -n "$SALE" ] && echo yes || echo no)"
chk "sale total is 72.000" "72000" "$(f "$BODY" '.total')"
A_HPP=$(row "$BODY" | jq -r '[.lines[].qty * .lines[].cost_at_sale] | add // 0' 2>/dev/null)
A_HPP=$(row "$BODY" | jq -r '(.lines // []) | map((.qty|tonumber) * (.cost_at_sale|tonumber)) | add // 0')
echo "  device A HPP from the sale's own lines: $A_HPP"
chk "device A HPP is 43.500 (5x7500 + 3x2000)" "43500" "$A_HPP"

say "3. device B: learn the tenant ONLY through /sync/pull"
CURSOR_B=$(pull_into "$CURSOR_B" /tmp/opencode/td-b-1.jsonl)
echo "  device B pulled $(wc -l < /tmp/opencode/td-b-1.jsonl) change rows, cursor=$CURSOR_B"

B_ITEM_QTY=$(jq -rs '[.[] | select(.table=="stock_level") | select(.row.item_id=="'"$ITEM"'")] | last | .row.qty // "missing"' /tmp/opencode/td-b-1.jsonl)
chk_num "device B stock for the item" 15 "$B_ITEM_QTY"

B_SALE_ROWS=$(jq -rs --arg s "$SALE" '[.[] | select(.table=="sale") | select(.row.id==$s)] | length' /tmp/opencode/td-b-1.jsonl)
chk "device B received the sale row" "1" "$B_SALE_ROWS"

# THE SHARP ASSERTION: lines must be embedded in the pulled sale row.
B_LINES=$(jq -rs --arg s "$SALE" '[.[] | select(.table=="sale") | select(.row.id==$s)][0].row.lines | if .==null then "MISSING" else (length|tostring) end' /tmp/opencode/td-b-1.jsonl)
chk "pulled sale carries an embedded lines array" "2" "$B_LINES"

B_HPP=$(jq -rs --arg s "$SALE" '
  [.[] | select(.table=="sale") | select(.row.id==$s)][0].row.lines
  | if .==null then "" else (map((.qty|tonumber) * (.cost_at_sale|tonumber)) | add | tostring) end' /tmp/opencode/td-b-1.jsonl)
if [ -z "$B_HPP" ] || [ "$B_HPP" = "null" ]; then
  bad "device B HPP breakdown is EMPTY — revenue would show with no HPP (section C blocker)"
else
  chk "device B HPP equals device A HPP" "$A_HPP" "$B_HPP"
fi

B_LINE_ITEMS=$(jq -rs --arg s "$SALE" '[.[] | select(.table=="sale") | select(.row.id==$s)][0].row.lines // [] | map(.item_id) | sort | join(",")' /tmp/opencode/td-b-1.jsonl)
echo "  device B line item ids: $B_LINE_ITEMS"

B_SALE_TOTAL=$(jq -rs --arg s "$SALE" '[.[] | select(.table=="sale") | select(.row.id==$s)][0].row.total // ""' /tmp/opencode/td-b-1.jsonl)
chk "device B sale total matches" "72000" "$B_SALE_TOTAL"

say "4. replay the same push batch — every op must be duplicate"
# UUIDv7-shaped, unique per run: ms timestamp + random tail
OP1=$(printf '019%05x-0000-7000-8000-%012x' $(( ($STAMP) % 1048576 )) $(( STAMP * 7919 % 281474976710656 )))
DEV_A="01900000-0000-7000-8000-0000000000aa"
BATCH=$(jq -nc --arg op "$OP1" --arg i "$ITEM" --arg o "$OUTLET" --arg d "$TODAY" --arg dev "$DEV_A" '{device_id:$dev,ops:[{op_id:$op,type:"stock_move.create",client_ts:"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",payload:{item_id:$i,outlet_id:$o,type:"in",qty_positive:2,unit_cost:6000,business_date:$d}}]}')
call POST /sync/push "$BATCH" "$TOKEN"
chk "push accepted" "200" "$CODE"
FIRST_STATUS=$(row "$BODY" | jq -r '.results[0].status // empty')
chk "first push applied" "applied" "$FIRST_STATUS"
call POST /sync/push "$BATCH" "$TOKEN"
chk "replayed push -> duplicate" "duplicate" "$(row "$BODY" | jq -r '.results[0].status // empty')"
call GET "/items/$ITEM" "" "$TOKEN"
chk "stock after one apply + replay is 17 (15+2, not 19)" "17" "$(f "$BODY" '.stock')"

say "5. void the sale — device B must see it voided, not gone"
call POST "/sales/$SALE/void" "$(jq -nc '{reason:"TD void"}')" "$TOKEN"
chk "void accepted" "200" "$CODE"
CURSOR_B=$(pull_into "$CURSOR_B" /tmp/opencode/td-b-2.jsonl)
echo "  device B pulled $(wc -l < /tmp/opencode/td-b-2.jsonl) more rows, cursor=$CURSOR_B"
B_VOID_ROWS=$(jq -rs --arg s "$SALE" '[.[] | select(.table=="sale") | select(.row.id==$s)] | length' /tmp/opencode/td-b-2.jsonl)
chk "voided sale still arrives as a sale row" "1" "$B_VOID_ROWS"
B_VOIDED=$(jq -rs --arg s "$SALE" '[.[] | select(.table=="sale") | select(.row.id==$s)][0].row.voided_at // "null"' /tmp/opencode/td-b-2.jsonl)
if [ "$B_VOIDED" = "null" ] || [ -z "$B_VOIDED" ]; then
  bad "voided sale arrived on device B WITHOUT voided_at — it would render as a live sale"
else
  ok "voided sale carries voided_at ($B_VOIDED)"
fi
# A tombstone would be deleted=true; a void is not a deletion.
B_DELETED=$(jq -rs --arg s "$SALE" '[.[] | select(.table=="sale") | select(.row.id==$s)][0].deleted // false' /tmp/opencode/td-b-2.jsonl)
chk "void is NOT a tombstone (deleted=false)" "false" "$B_DELETED"

say "6. device B's numbers equal device A's"
call GET "/reports/laba-rugi?from=${TODAY:0:8}01&to=$TODAY" "" "$TOKEN"
A_REV=$(f "$BODY" '.revenue'); A_NET=$(f "$BODY" '.net_profit'); A_OPEX=$(f "$BODY" '.opex')
echo "  device A (server): revenue=$A_REV net=$A_NET"
chk "voided sale contributes 0 revenue" "0" "$A_REV"

say "RESULT — target $BASE"
echo "  pass=$PASS fail=$FAIL"
[ "$FAIL" -gt 0 ] && printf '  failed: %s\n' "${FAILED[*]}"
exit "$FAIL"
