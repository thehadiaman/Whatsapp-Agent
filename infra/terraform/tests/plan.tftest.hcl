# Offline checks of the plan: a mocked AWS provider, so no account, no
# credentials, no network beyond the provider download. They pin the security
# properties the brief asks for, so a later edit cannot quietly drop one.
#   terraform -chdir=infra/terraform test

mock_provider "aws" {
  # Mocked values are known while planning, so conditions can read ARNs.
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-south-1a", "ap-south-1b"] }
  }

  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }

  # Policy documents are rendered by the provider; any valid JSON will do here.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::mock-bucket" }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
  }

  mock_resource "aws_instance" {
    defaults = { arn = "arn:aws:ec2:ap-south-1:123456789012:instance/i-0123456789abcdef0" }
  }

  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:ap-south-1:123456789012:repository/support-desk/api" }
  }
}

variables {
  domain                     = "desk.example.com"
  github_oidc_subject_prefix = "repo:owner/repo"
}

run "only_web_ports_are_open" {
  command = plan

  assert {
    condition = alltrue([
      for rule in aws_vpc_security_group_ingress_rule.web : contains([80, 443], rule.from_port) && rule.from_port == rule.to_port
    ])
    error_message = "Only ports 80 and 443 may be open (no SSH: Session Manager)."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.web) == 3
    error_message = "Expected exactly HTTP, HTTPS and HTTP/3."
  }

  assert {
    condition     = aws_subnet.public.map_public_ip_on_launch == false
    error_message = "The instance's only public address is its elastic IP."
  }
}

run "instance_is_locked_down" {
  command = plan

  assert {
    condition     = aws_instance.app.metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 must be required."
  }

  assert {
    condition     = aws_instance.app.metadata_options[0].http_put_response_hop_limit == 2
    error_message = "Containers need hop limit 2 to reach the instance role."
  }

  assert {
    condition     = aws_instance.app.root_block_device[0].encrypted && aws_ebs_volume.data.encrypted
    error_message = "Both volumes must be encrypted at rest."
  }

  assert {
    condition     = startswith(aws_instance.app.instance_type, "t4g.")
    error_message = "The default is one ARM instance (brief §5)."
  }

  assert {
    condition     = strcontains(file("${path.module}/user-data.sh.tftpl"), "sha256sum -c")
    error_message = "The Compose plugin download must be checked against its checksum."
  }
}

run "buckets_are_private_and_encrypted" {
  command = plan

  assert {
    condition = alltrue([
      for block in aws_s3_bucket_public_access_block.this :
      block.block_public_acls && block.block_public_policy && block.ignore_public_acls && block.restrict_public_buckets
    ])
    error_message = "Every bucket must block public access."
  }

  assert {
    condition = alltrue([
      for config in aws_s3_bucket_server_side_encryption_configuration.this :
      one(one(config.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    ])
    error_message = "Every bucket must encrypt at rest."
  }

  assert {
    condition = alltrue([
      for doc in data.aws_iam_policy_document.tls_only :
      one(doc.statement).effect == "Deny" && one(one(doc.statement).condition).variable == "aws:SecureTransport"
    ])
    error_message = "Every bucket must refuse plain HTTP."
  }
}

run "media_expires_after_the_configured_days" {
  command = plan

  variables {
    media_retention_days = 30
  }

  assert {
    condition     = one(aws_s3_bucket_lifecycle_configuration.media.rule).expiration[0].days == 30
    error_message = "Media retention must follow media_retention_days."
  }

  assert {
    condition     = one(one(aws_s3_bucket_lifecycle_configuration.media.rule).filter).prefix == "tenants/"
    error_message = "Retention applies to tenant media."
  }
}

run "least_privilege" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for doc in [data.aws_iam_policy_document.instance, data.aws_iam_policy_document.github_push, data.aws_iam_policy_document.github_deploy] : [
        for statement in doc.statement : [for action in statement.actions : !endswith(action, ":*") && action != "*"]
      ]
    ]))
    error_message = "No wildcard actions in the app or CI policies."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.instance.statement :
      alltrue([for action in statement.actions : !startswith(action, "s3:")]) || alltrue([for resource in statement.resources : !endswith(resource, ":::*")])
    ])
    error_message = "S3 access is scoped to the app's buckets."
  }

  assert {
    condition     = aws_ecr_repository.app["api"].image_tag_mutability == "IMMUTABLE"
    error_message = "Image tags are commit SHAs and must not be overwritten."
  }
}

run "ci_roles_trust_only_this_repository" {
  command = plan

  assert {
    condition     = toset(one([for c in one(data.aws_iam_policy_document.github_assume["push"].statement).condition : c.values if c.variable == "token.actions.githubusercontent.com:sub"])) == toset(["repo:owner/repo:ref:refs/heads/main"])
    error_message = "The push role trusts only main of this repository."
  }

  assert {
    condition     = toset(one([for c in one(data.aws_iam_policy_document.github_assume["deploy"].statement).condition : c.values if c.variable == "token.actions.githubusercontent.com:sub"])) == toset(["repo:owner/repo:environment:production"])
    error_message = "The deploy role trusts only the production environment."
  }
}

run "budget_only_with_an_email" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.monthly) == 0
    error_message = "No email, no budget."
  }
}

run "budget_with_an_email" {
  command = plan

  variables {
    budget_email = "ops@example.com"
  }

  assert {
    condition     = length(aws_budgets_budget.monthly) == 1
    error_message = "A budget is created when an email is given."
  }
}

run "rejects_a_non_arm_instance" {
  command = plan

  variables {
    instance_type = "t3.medium"
  }

  expect_failures = [var.instance_type]
}
