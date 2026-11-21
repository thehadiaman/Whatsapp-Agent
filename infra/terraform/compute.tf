# One ARM instance runs web, api, worker, postgres, redis and caddy with
# Docker Compose (brief §5). Data lives on its own encrypted volume, so the
# instance can be replaced without touching the database.

data "aws_ssm_parameter" "al2023_arm64" {
  # Amazon Linux 2023 user guide: the public parameter for the latest arm64 AMI.
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.public.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true

  tags = { Name = "${local.name}-data" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  monitoring             = false

  # IMDSv2 only. Hop limit 2: containers on Docker's bridge network are one
  # hop further away and need the instance role's credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    data_volume_id = aws_ebs_volume.data.id
    region         = var.region
    ssm_path       = local.ssm_path
    ops_bucket     = aws_s3_bucket.this["ops"].id
    ecr_registry   = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    domain         = var.domain
  })

  tags = { Name = local.name }

  lifecycle {
    # A newer AMI must not replace the instance on the next apply; replacing
    # it is a planned step (docs/RUNBOOK.md, "Replace the instance").
    ignore_changes = [ami, user_data]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id
}

# A fixed address for the DNS record and for Meta's webhook calls.
resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id

  tags = { Name = local.name }

  depends_on = [aws_internet_gateway.main]
}
