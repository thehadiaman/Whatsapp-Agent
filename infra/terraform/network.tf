# A small VPC of its own: one public subnet, no NAT (the instance has a public
# address and only 80/443 open). One Availability Zone is the single-instance
# trade-off the README states.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

# The default security group of a new VPC allows all traffic between its
# members. Nothing uses it; take every rule away.
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.1.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]
  # The elastic IP gives the instance its address; no automatic public IP.
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Only HTTP and HTTPS come in (HTTP for the certificate challenge and the
# redirect; UDP 443 for HTTP/3). No SSH: Session Manager reaches the box.
resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "HTTP and HTTPS in; all out (Meta, Bedrock, S3, SSM, ECR)."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-web" }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = {
    http  = { port = 80, protocol = "tcp" }
    https = { port = 443, protocol = "tcp" }
    http3 = { port = 443, protocol = "udp" }
  }

  security_group_id = aws_security_group.web.id
  description       = each.key
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = each.value.port
  to_port           = each.value.port
  ip_protocol       = each.value.protocol
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.web.id
  description       = "Outbound to AWS APIs, Meta's Graph API, image pulls and OS updates."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
