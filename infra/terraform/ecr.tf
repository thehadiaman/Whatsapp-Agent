# One repository per production image. Tags are commit SHAs and immutable,
# so a deploy always runs exactly the image CI built and tested.

locals {
  images = toset(["api", "worker", "web", "simulator"])
}

resource "aws_ecr_repository" "app" {
  for_each = local.images

  name                 = "${var.project}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Keep the last 20 images: enough to roll back weeks of deploys.
resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 20 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}
