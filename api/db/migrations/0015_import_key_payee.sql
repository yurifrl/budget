-- Statement-import idempotency key gains the payee.
--
-- Rows imported without an explicit import_id get a generated one,
-- YNAB:<milliunits>:<date>:<occurrence>, whose uniqueness was date + signed
-- amount only. Two different vendors charging the same amount on the same day
-- collided, so a re-import swallowed one of them as a duplicate. The key is
-- now the (date, payee, signed amount) triple; the occurrence only breaks
-- ties between rows whose whole key is identical (same vendor, same day,
-- same amount, charged twice).
--
-- Rewrite existing generated ids in place — append the row's resolved payee
-- (or '-' when unbound) before the occurrence. Legacy ids that came from a
-- real YNAB export rather than this route also match the pattern; rewriting
-- them trades exact-match dedupe for the same triple rule, which is the
-- intended behaviour. Idempotent by construction: new-format ids carry
-- ':<payee>:' between the date and the occurrence, so the pattern below
-- never matches them twice.

update public.transactions
set import_id = regexp_replace(
      import_id,
      '^(YNAB:[-0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2}):([0-9]+)$',
      '\1:' || coalesce(payee_id::text, '-') || ':\2'
    )
where import_id ~ '^YNAB:[-0-9]+:[0-9]{4}-[0-9]{2}-[0-9]{2}:[0-9]+$';
