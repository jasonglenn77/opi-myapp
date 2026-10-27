"""
Every fixed rule the app uses to place dates and money, read from the code's
own constants so the Assumptions page always shows what is actually running.
Measured values (expense timing, payment lag) live in forecast_assumptions;
this is the other half: rules someone decided, not averages.

Each rule: area, name, value (as shown), what it drives, and where it lives.
When a constant changes in code, the page changes with it.
"""
from sqlalchemy import text


def _pct_terms(terms):
    return " / ".join(f"{int(p)}% {lbl.split(' (')[0].lower()} ({key})" for _, lbl, p, key in terms)


def rules(conn):
    from app.billing import routes as B
    from app.invoices.routes import DEFAULT_TERMS
    from app.expenses.routes import _CATEGORY_KEYWORDS, NON_EXPENSE_PREFIXES, CATEGORIES
    from app.gsync.payment_import import PAYROLL_ANCHOR
    from app.cashflow import service as CF, overhead as OV
    from app.cashflow.revenue_forecast import BUCKETS as PIPE_BUCKETS
    from app.assumptions import calibrate as CAL
    from app.jobcost import service as JC

    kw = {}
    for word, cat in _CATEGORY_KEYWORDS:
        kw.setdefault(cat, []).append(word)
    out = [
        # --- invoices -------------------------------------------------------
        {"area": "Invoices", "name": "Default invoice schedule",
         "value": _pct_terms(DEFAULT_TERMS),
         "drives": "The invoice milestones created for each accepted estimate (editable per project).",
         "where": "invoices/routes.py DEFAULT_TERMS, billing/routes.py DEFAULT_PERCENTS"},
        {"area": "Invoices", "name": "Default payment terms",
         "value": f"Net {B.DEFAULT_NET_DAYS} days",
         "drives": "Each milestone's due date = invoice date + net days.",
         "where": "billing/routes.py DEFAULT_NET_DAYS"},
        {"area": "Invoices", "name": "When a payment is expected",
         "value": "Hand-entered expected date, else the milestone's expected date, else the QuickBooks due date",
         "drives": "The week an open invoice lands in the cash-flow forecast.",
         "where": "billing/routes.py invoice_expected_dates"},
        # --- crew -----------------------------------------------------------
        {"area": "Crew pay", "name": "Crew payment schedule",
         "value": "Estimate Contract Labor split evenly, paid bi-weekly in arrears across the job; "
                  "the Drive Payment Schedule replaces it when one exists",
         "drives": "Crew installments per estimate (Payments tab) and the crew lines of the forecast.",
         "where": "billing/routes.py _ensure_crew_schedules, gsync/payment_import.py"},
        {"area": "Crew pay", "name": "Payday cycle",
         "value": f"Every other Friday, anchored on {PAYROLL_ANCHOR:%b %d, %Y}",
         "drives": "Flags Payment Schedule dates that fall off the pay cycle (Data Review).",
         "where": "gsync/payment_import.py PAYROLL_ANCHOR"},
        {"area": "Crew pay", "name": "Matching a QuickBooks crew bill to an installment",
         "value": f"Bill dated {CF.CREW_MATCH_EARLY_DAYS} days before to {CF.CREW_MATCH_WINDOW_DAYS} days after "
                  f"the pay date, within ${CF.CREW_MATCH_TOL_ABS:,.0f} or {CF.CREW_MATCH_TOL_PCT:.0%}",
         "drives": "Whether a scheduled crew payment counts as paid.",
         "where": "cashflow/service.py CREW_MATCH_*"},
        # --- expenses -------------------------------------------------------
        {"area": "Expenses", "name": "Expense categories",
         "value": "; ".join(f"{c}: {', '.join(kw.get(c, []))}" for c in CATEGORIES if kw.get(c))
                  + "; anything else: Other",
         "drives": "Which category an estimate cost line or QuickBooks bill line counts toward "
                   "(keyword in the item or account name).",
         "where": "expenses/routes.py _CATEGORY_KEYWORDS"},
        {"area": "Expenses", "name": "Not counted as project expenses",
         "value": ", ".join(NON_EXPENSE_PREFIXES),
         "drives": "Contract Labor is crew pay; Buffer and OH&P are margin, not money going out.",
         "where": "expenses/routes.py NON_EXPENSE_PREFIXES"},
        {"area": "Expenses", "name": "How an expense estimate is spread over time",
         "value": f"By the category's timing profile (table above) when it is measured from at least "
                  f"{CAL.MIN_PROJECTS} projects; otherwise evenly across the project weeks",
         "drives": "The weekly expense rows on each project and the expense lines of the forecast. "
                   "Hand-edited rows are never re-spread.",
         "where": "assumptions/calibrate.py profile_split, billing/routes.py _ensure_expense_installments"},
        {"area": "Expenses", "name": "How actual bills burn down the plan",
         "value": "QuickBooks bills fill the earliest planned weeks first; what is left stays on the schedule",
         "drives": "Paid / Partial / Scheduled status on each expense row; only the unspent part is forecast.",
         "where": "billing/routes.py _compose_expenses"},
        # --- job cost -------------------------------------------------------
        {"area": "Job cost", "name": "Estimate vs actual",
         "value": "Estimate = cost lines of the project's accepted/converted estimates in QuickBooks; "
                  "actual = QuickBooks bills and card purchases tagged to the project",
         "drives": "The Overview page's job cost table. Only QuickBooks Projects count (used since Dec 2024); "
                   "older jobs have no job-tagged costs.",
         "where": "jobcost/service.py"},
        {"area": "Job cost", "name": "Finished job",
         "value": f"Scheduled end date at least {JC.FINISHED_AFTER_DAYS} days ago, or status completed",
         "drives": "Which jobs count as finished (late bills have time to arrive).",
         "where": "jobcost/service.py FINISHED_AFTER_DAYS"},
        {"area": "Job cost", "name": "Over estimate",
         "value": f"Actual more than {JC.OVER_PCT:.0%} above the estimate for that category",
         "drives": "The \"jobs over\" counts and dollars.", "where": "jobcost/service.py OVER_PCT"},
        {"area": "Job cost", "name": "Lifts vs other rentals",
         "value": "Any cost line with \"lift\" in its name counts as Lifts; other rental keywords as Other rentals",
         "drives": "Lifts are shown on their own: the largest non-crew cost.", "where": "jobcost/service.py category_of"},
        # --- cash flow ------------------------------------------------------
        {"area": "Cash flow", "name": "Forecast weeks",
         "value": f"{CF.WEEKS} weeks, each ending Friday",
         "drives": "The Cash Flow grid.", "where": "cashflow/service.py WEEKS, WEEK_END_WEEKDAY"},
        {"area": "Cash flow", "name": "Overhead run-rate window",
         "value": f"Trailing {CF.RUNRATE_TRAILING_WEEKS} weeks of QuickBooks spend",
         "drives": "Auto overhead lines on the Cash Flow page.", "where": "cashflow/service.py RUNRATE_TRAILING_WEEKS"},
        {"area": "Cash flow", "name": "Card-paid overhead accounts",
         "value": f"An account with {OV.CARD_PAID_SHARE:.0%}+ of its spend on credit cards gets no overhead line "
                  "(the card payment line covers it)",
         "drives": "Avoids counting card spend twice.", "where": "cashflow/overhead.py CARD_PAID_SHARE"},
        {"area": "Cash flow", "name": "Starting bank balance",
         "value": "QuickBooks book balance of the bank accounts (the bank-feed balance is not available "
                  "through the QuickBooks API; see Data Review, Cash flow sources)",
         "drives": "The opening cash on the Cash Flow page.", "where": "cashflow/service.py"},
        {"area": "Cash flow", "name": "Pipeline revenue weighting",
         "value": ", ".join(lbl for _, lbl in PIPE_BUCKETS) + " (the percent in the stage name is the weight)",
         "drives": "Projected revenue from opportunities not yet won.", "where": "cashflow/revenue_forecast.py"},
    ]
    # Overhead lines still carrying a value typed on OPI's B250 (no system of record yet).
    try:
        for r in conn.execute(text("""
            SELECT name, amount, cadence, source_note FROM cashflow_overhead
            WHERE source = 'b250' AND deleted_at IS NULL AND active = 1 ORDER BY name
        """)).mappings().all():
            out.append({"area": "Cash flow", "name": f"Overhead: {r['name']}",
                        "value": f"${float(r['amount'] or 0):,.2f} {r['cadence']} (copied from OPI's B250)",
                        "drives": r["source_note"] or "Cash Flow overhead line.",
                        "where": "cashflow_overhead (source = b250)", "flag": "b250"})
    except Exception:
        pass
    return out
