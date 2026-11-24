#!/usr/bin/env bash
# Captain integration QA — docs/ACCEPTANCE.md section A (accounting spine) and
# section B (ledger integrity) against a running API, by hand-equivalent HTTP.
#
# Usage:  API_BASE=http://127.0.0.1:8080/v1 ./docs/qa/acceptance-spine.sh
# Needs:  curl, jq. Creates a fresh tenant per run (no data is deleted).
#
# Every check prints EXPECTED vs ACTUAL and a PASS/FAIL. Exit code = number of failures.
# B11 (opname) is not exercised: T-124 is Sprint 2 and absent from the first increment.

set -uo pipefail
BASE="${API_BASE:-http://127.0.0.1:8080/v1}"
TODAY="${BUSINESS_DATE:-$(date +%F)}"
STAMP="$(date +%s)"
EMAIL="qa+${STAMP}@demo.test"
PASS=0; FAIL=0; FAILED_NAMES=()

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); printf '  FAIL  %s\n' "$1"; }
chk()  { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1 — expected [$2] got [$3]"; fi
}
chk_code2() { # label code  (accept 200 or 201)
  if [ "$2" = "200" ] || [ "$2" = "201" ]; then ok "$1 ($2)"; else bad "$1 — expected 200/201 got [$2]"; fi
}
chk_num() { # label expected actual (numeric, tolerate 6000 vs 6000.0)
  local a b
  a=$(printf '%s' "$2" | tr -d ' '); b=$(printf '%s' "$3" | tr -d ' ')
  if [ "$(jq -n --argjson a "${a:-null}" --argjson b "${b:-null}" '$a == $b' 2>/dev/null)" = "true" ]; then
    ok "$1 ($3)"
  else
    bad "$1 — expected [$2] got [$3]"
  fi
}

BODY=""; CODE=""
call() { # method path [json-body] [token]
  local m=$1 p=$2 b=${3:-} t=${4:-} args=(-sS -X "$m" -H 'Content-Type: application/json' -w '\n%{http_code}')
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "$b" ] && args+=(--data "$b")
  local raw; raw=$(curl "${args[@]}" "$BASE$p" 2>&1) || { BODY="$raw"; CODE=000; return; }
  CODE=$(printf '%s' "$raw" | tail -n1)
  BODY=$(printf '%s' "$raw" | sed '$d')
}
# unwrap: contract lists are {data:[...]}; writes return the row itself
row() { jq -c 'if type=="object" and has("data") then .data else . end' <<<"$1"; }
f()   { row "$1" | jq -r "$2 // empty"; }

say "0. health"
call GET /health
echo "  GET /health -> $CODE $BODY"
[ "$CODE" = "200" ] && ok "health 200" || bad "health expected 200 got $CODE"

say "1. signup fresh shop (owner)"
call POST /auth/signup "$(jq -nc --arg e "$EMAIL" '{email:$e,password:("Qa-'"$STAMP"'-pass"),name:"QA Owner",business_name:"QA Warung '"$STAMP"'"}')"
echo "  $CODE $(row "$BODY" | head -c 300)"
TOKEN=$(f "$BODY" '.access_token')
OUTLET=$(f "$BODY" '.outlet.id')
[ -n "$TOKEN" ] && ok "owner token issued" || bad "no access_token from signup"
[ -n "$OUTLET" ] && ok "outlet created ($OUTLET)" || bad "no outlet in signup response"

say "2. A1 create item Gula 1 kg — sale 12.000 cost 0"
call POST /items "$(jq -nc --arg o "$OUTLET" '{name:"Gula 1 kg",sku:"QA-GULA-'"$STAMP"'",barcodes:[],base_unit:"kg",units:[{name:"kg",factor:1}],sale_price:12000,cost:0,min_stock:0,active:true}')" "$TOKEN"
echo "  $CODE $(row "$BODY" | head -c 400)"
ITEM=$(f "$BODY" '.id'); chk "item created" "yes" "$([ -n "$ITEM" ] && echo yes || echo no)"

say "3. A2 stock in 10 @ 6.000 -> stock 10, cost_avg 6.000"
call POST /stock-moves "$(jq -nc --arg i "$ITEM" --arg o "$OUTLET" --arg d "$TODAY" '{item_id:$i,outlet_id:$o,type:"in",qty_positive:10,unit_cost:6000,business_date:$d,supplier:"QA"}')" "$TOKEN"
chk_code2 "stock-in 10 accepted" "$CODE"
call GET "/items/$ITEM" "" "$TOKEN"
chk_num "stock after A2" 10 "$(f "$BODY" '.stock')"
chk_num "cost_avg after A2" 6000 "$(f "$BODY" '.cost_avg')"

say "4. A3 stock in 10 @ 9.000 -> stock 20, cost_avg 7.500 (moving average)"
call POST /stock-moves "$(jq -nc --arg i "$ITEM" --arg o "$OUTLET" --arg d "$TODAY" '{item_id:$i,outlet_id:$o,type:"in",qty_positive:10,unit_cost:9000,business_date:$d,supplier:"QA"}')" "$TOKEN"
chk_code2 "stock-in 10@9000 accepted" "$CODE"
MOV9000=$(f "$BODY" '.id')
call GET "/items/$ITEM" "" "$TOKEN"
chk_num "stock after A3" 20 "$(f "$BODY" '.stock')"
chk_num "cost_avg after A3 is the moving average" 7500 "$(f "$BODY" '.cost_avg')"

say "5. A4 sell 5 @ 12.000 cash -> stock 15, total 60.000, cost_at_sale 7.500"
call POST /sales "$(jq -nc --arg o "$OUTLET" --arg i "$ITEM" --arg d "$TODAY" '{outlet_id:$o,business_date:$d,customer_id:null,discount:0,payment_method:"cash",paid:true,note:"QA",lines:[{item_id:$i,qty:5,unit_price:12000,discount:0}]}')" "$TOKEN"
echo "  $CODE $(row "$BODY" | head -c 500)"
SALE=$(f "$BODY" '.id')
chk "sale posted" "yes" "$([ -n "$SALE" ] && echo yes || echo no)"
chk_num "sale total" 60000 "$(f "$BODY" '.total')"
chk_num "sale line cost_at_sale" 7500 "$(row "$BODY" | jq -r '.lines[0].cost_at_sale // empty')"
call GET "/items/$ITEM" "" "$TOKEN"
chk_num "stock after sale" 15 "$(f "$BODY" '.stock')"

say "6. A5 cash out 5.000 category listrik"
call POST /cash-entries "$(jq -nc --arg o "$OUTLET" --arg d "$TODAY" '{outlet_id:$o,direction:"out",amount:5000,category:"listrik",method:"cash",business_date:$d,note:"QA listrik"}')" "$TOKEN"
echo "  $CODE $(row "$BODY" | head -c 300)"
CASH=$(f "$BODY" '.id'); chk "cash out posted" "yes" "$([ -n "$CASH" ] && echo yes || echo no)"

say "7. A6 laba rugi this month — revenue 60.000 HPP 37.500 gross 22.500 opex 5.000 net 17.500"
FROM="${TODAY:0:8}01"; TO="$TODAY"
call GET "/reports/laba-rugi?from=$FROM&to=$TO&compare=false" "" "$TOKEN"
echo "  $CODE $(row "$BODY" | head -c 600)"
REV=$(f "$BODY" '.revenue'); HPP=$(f "$BODY" '.hpp'); GROSS=$(f "$BODY" '.gross_profit')
OPEX=$(f "$BODY" '.opex'); NET=$(f "$BODY" '.net_profit')
chk_num "revenue"  60000 "$REV"
chk_num "hpp"      37500 "$HPP"
chk_num "gross"    22500 "$GROSS"
chk_num "opex"      5000 "$OPEX"
chk_num "net"      17500 "$NET"
chk_num "revenue - hpp - opex = net" "$NET" "$(( ${REV:-0} - ${HPP:-0} - ${OPEX:-0} ))"

say "8. A7 drill-downs"
call GET "/reports/laba-rugi/drill?line=revenue&from=$FROM&to=$TO" "" "$TOKEN"
chk "revenue drill 200" "200" "$CODE"
chk "revenue drill lists the sale" "yes" "$(jq -r 'if ((.data // .rows // [])|length)>0 then "yes" else "no" end' <<<"$BODY" 2>/dev/null)"
call GET "/reports/laba-rugi/drill?line=hpp&from=$FROM&to=$TO" "" "$TOKEN"
chk "hpp drill 200" "200" "$CODE"
call GET "/reports/laba-rugi/drill?line=opex&from=$FROM&to=$TO" "" "$TOKEN"
chk "opex drill 200" "200" "$CODE"

say "9. A8 buy 10 more @ 6.000 — net profit must not change (stock is not expense)"
call POST /stock-moves "$(jq -nc --arg i "$ITEM" --arg o "$OUTLET" --arg d "$TODAY" '{item_id:$i,outlet_id:$o,type:"in",qty_positive:10,unit_cost:6000,business_date:$d,supplier:"QA"}')" "$TOKEN"
sleep 0.2
call GET "/reports/laba-rugi?from=$FROM&to=$TO" "" "$TOKEN"
chk_num "net unchanged after stock purchase" 17500 "$(f "$BODY" '.net_profit')"
chk_num "opex unchanged after stock purchase" 5000 "$(f "$BODY" '.opex')"
call GET "/items/$ITEM" "" "$TOKEN"
STOCK_NOW=$(f "$BODY" '.stock'); COST_NOW=$(f "$BODY" '.cost_avg')
chk_num "stock after A8" 25 "$STOCK_NOW"
echo "  NOTE  stock value at cost = $(( ${STOCK_NOW:-0} * ${COST_NOW:-0} )) (qty $STOCK_NOW x avg $COST_NOW);"
echo "        ACCEPTANCE.md A8 says 150.000 — see docs/qa/QA-LOG.md discrepancy note"

say "10. B9 reverse the 10 @ 9.000 stock-in after the sale"
call POST "/stock-moves/preview-reverse/$MOV9000" "" "$TOKEN"
echo "  preview $CODE $(row "$BODY" | head -c 300)"
chk "preview-reverse 200" "200" "$CODE"
call POST "/stock-moves/$MOV9000/reverse" "$(jq -nc --arg d "$TODAY" '{reason:"QA reverse",business_date:$d}')" "$TOKEN"
echo "  reverse $CODE $(row "$BODY" | head -c 300)"
chk_code2 "reverse accepted" "$CODE"
call GET "/items/$ITEM" "" "$TOKEN"
chk_num "stock after reversal (25-10)" 15 "$(f "$BODY" '.stock')"
call GET "/items/$ITEM/ledger?outlet_id=$OUTLET" "" "$TOKEN"
LEDGER_OK=$(jq -r '
  (if type=="object" and has("data") then .data else . end)
  | (.rows // .) as $r
  | reduce ($r[]) as $x ({sum:0, ok:true};
      .sum += ($x.qty_delta|tonumber)
      | .ok = (.ok and (($x.balance|tonumber) == .sum)))
  | .ok' <<<"$BODY" 2>/dev/null)
chk "ledger running balance == sum of deltas on every row" "true" "$LEDGER_OK"

say "11. B10 negative stock allowed and flagged"
call POST /items "$(jq -nc '{name:"QA Negatif '"$STAMP"'",barcodes:[],base_unit:"pcs",units:[{name:"pcs",factor:1}],sale_price:1000,cost:500,min_stock:0,active:true}')" "$TOKEN"
NEG=$(f "$BODY" '.id')
call POST /stock-moves "$(jq -nc --arg i "$NEG" --arg o "$OUTLET" --arg d "$TODAY" '{item_id:$i,outlet_id:$o,type:"in",qty_positive:5,unit_cost:500,business_date:$d}')" "$TOKEN"
call POST /sales "$(jq -nc --arg o "$OUTLET" --arg i "$NEG" --arg d "$TODAY" '{outlet_id:$o,business_date:$d,discount:0,payment_method:"cash",paid:true,lines:[{item_id:$i,qty:20,unit_price:1000,discount:0}]}')" "$TOKEN"
NEGSALE=$(f "$BODY" '.id'); chk "selling below zero succeeds" "yes" "$([ -n "$NEGSALE" ] && echo yes || echo no)"
call GET "/items/$NEG" "" "$TOKEN"
echo "  item after negative sale: stock=$(f "$BODY" '.stock') low_stock=$(f "$BODY" '.low_stock')"
chk_num "stock is -15" -15 "$(f "$BODY" '.stock')"

say "12. B11 opname — DEFERRED (T-124 is Sprint 2, not in this increment)"
echo "  SKIP  opname atomic post: not implemented in increment 1"

say "13. B12 void the sale -> stock restored, cash reversed, revenue drops"
call POST "/sales/$SALE/void" "$(jq -nc '{reason:"QA void"}')" "$TOKEN"
echo "  void $CODE $(row "$BODY" | head -c 300)"
chk_code2 "void accepted" "$CODE"
call GET "/items/$ITEM" "" "$TOKEN"
chk_num "stock restored after void (was 15)" 20 "$(f "$BODY" '.stock')"
call GET "/sales/$SALE" "" "$TOKEN"
echo "  sale after void: voided_at=$(f "$BODY" '.voided_at')"
chk "sale still exists and is marked void" "yes" "$([ -n "$(f "$BODY" '.voided_at')" ] && echo yes || echo no)"

say "14. B13 delete an item with movements -> 409 readable"
call DELETE "/items/$ITEM" "" "$TOKEN"
echo "  $CODE $BODY"
chk "delete with movements refused 409" "409" "$CODE"

say "15. E21 staff token is refused cost and reports — needs a seeded staff account"
if [ -n "${STAFF_EMAIL:-}" ] && [ -n "${STAFF_PASSWORD:-}" ]; then
  call POST /auth/login "$(jq -nc --arg e "$STAFF_EMAIL" --arg p "$STAFF_PASSWORD" '{email:$e,password:$p}')"
  STAFF=$(f "$BODY" '.access_token')
  if [ -z "$STAFF" ]; then
    bad "staff login produced no token ($CODE)"
  else
    call GET /reports/laba-rugi "" "$STAFF"
    chk "staff GET /reports/laba-rugi -> 403" "403" "$CODE"
    call GET "/items?q=Gula" "" "$STAFF"
    STAFF_HAS_COST=$(jq -r 'if type=="object" and has("data") then .data else . end | (.[0] // {}) | has("cost_avg")' <<<"$BODY" 2>/dev/null)
    chk "staff item list omits cost_avg" "false" "$STAFF_HAS_COST"
    call POST /items "$(jq -nc '{name:"Staff should not",barcodes:[],base_unit:"pcs",units:[{name:"pcs",factor:1}],sale_price:1,cost:1,min_stock:0,active:true}')" "$STAFF"
    chk "staff POST /items -> 403" "403" "$CODE"
  fi
else
  echo "  SKIP  set STAFF_EMAIL/STAFF_PASSWORD (seed: staff@demo.test) to test the 403s"
fi

say "RESULT"
echo "  pass=$PASS fail=$FAIL"
[ "$FAIL" -gt 0 ] && { printf '  failed: %s\n' "${FAILED_NAMES[*]}"; }
exit "$FAIL"