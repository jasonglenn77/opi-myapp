import os
import uuid
from botocore.config import Config
import boto3

AWS_REGION = os.getenv("AWS_REGION")
AWS_BUCKET = os.getenv("AWS_BUCKET")
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
S3_PREFIX = os.getenv("S3_PREFIX", "projects").strip("/")

if not all([AWS_REGION, AWS_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]):
    raise RuntimeError(
        "Missing S3 env vars. Need AWS_REGION, AWS_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY."
    )

s3_client = boto3.client(
    "s3",
    region_name=AWS_REGION,
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
    config=Config(signature_version="s3v4"),
)

def build_project_file_key(qbo_customer_id: int, filename: str) -> str:
    ext = ""
    if "." in filename:
        ext = "." + filename.rsplit(".", 1)[1].lower()

    file_id = str(uuid.uuid4())
    return f"{S3_PREFIX}/{qbo_customer_id}/{file_id}{ext}"

def public_file_url(key: str) -> str:
    return f"https://{AWS_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}"

def signed_file_url(key: str, expires_in: int = 3600) -> str:
    return s3_client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": AWS_BUCKET,
            "Key": key,
        },
        ExpiresIn=expires_in,
    )