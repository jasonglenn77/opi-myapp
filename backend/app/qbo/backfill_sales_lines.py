from app.qbo.service import backfill_sales_lines_from_existing

if __name__ == "__main__":
    result = backfill_sales_lines_from_existing()
    print(result)