output "public_ip" {
  description = "Point the domain's A record here."
  value       = aws_eip.app.public_ip
}

output "instance_id" {
  description = "For Session Manager and the DEPLOY_INSTANCE_ID GitHub variable."
  value       = aws_instance.app.id
}

output "ssm_path" {
  description = "Where settings and secrets live in Parameter Store."
  value       = local.ssm_path
}

output "media_bucket" {
  value = aws_s3_bucket.this["media"].id
}

output "ops_bucket" {
  description = "Backups and release bundles (the OPS_BUCKET GitHub variable)."
  value       = aws_s3_bucket.this["ops"].id
}

output "media_origin" {
  description = "The MEDIA_ORIGIN GitHub variable: the web build's content policy allows playback from here."
  value       = "https://${aws_s3_bucket.this["media"].bucket_regional_domain_name}"
}

output "ecr_registry" {
  value = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"
}

output "github_push_role_arn" {
  value = aws_iam_role.github["push"].arn
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github["deploy"].arn
}
