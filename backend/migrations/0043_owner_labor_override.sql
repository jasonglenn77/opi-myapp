-- 0043 Pin Owner Guaranteed Contract Labor to the current $300k/mo rate.
-- Owner draws rose through the year (3 owners x $60k -> $100k each by Jul = $300k/mo).
-- The trailing-12-mo run-rate averages lower (~$174k/mo), so left as an auto item the
-- nightly refresh would drag it down to the stale average. Pin it as a manual override
-- (edited=1) at the current rate, per OPI. Keyed by name (dev + prod safe, idempotent).
UPDATE cashflow_overhead
   SET amount = 300000.00,
       cadence = 'monthly',
       edited = 1
 WHERE name = 'General and Admin Payroll:Owner Guaranteed Contract Labor'
   AND deleted_at IS NULL;
