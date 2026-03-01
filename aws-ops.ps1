# aws-ops.ps1
# All AWS operations for Log Analyzer (ECS Fargate + ALB)
# Usage: .\aws-ops.ps1 <command>
#   deploy          - Build, push, and deploy new version
#   status          - Check service and ALB health
#   on              - Start service (2 tasks)
#   off             - Stop service (0 tasks)
#   ip              - Get direct task IP (bypasses ALB)
#   logs            - Tail CloudWatch logs
#   setup-infra     - Create ALB, target group, security groups (first-time)
#   setup-scaling   - Configure auto-scaling + office hours schedule
#   update-service  - Connect ECS service to ALB target group

param(
    [Parameter(Position=0)]
    [ValidateSet("deploy","status","on","off","ip","logs","setup-infra","setup-scaling","update-service")]
    [string]$Command
)

$ErrorActionPreference = "Stop"
$REGION = "eu-north-1"
$CLUSTER = "log-analyzer-cluster"
$SERVICE = "log-analyzer-service"
$ALB_NAME = "log-analyzer-alb"
$TG_NAME = "log-analyzer-tg"
$ECR_REPO = "log-analyzer-poc-v2"

if (-not $Command) {
    Write-Host "Usage: .\aws-ops.ps1 <command>" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Commands:" -ForegroundColor Yellow
    Write-Host "  deploy          Build, push Docker image, deploy to ECS"
    Write-Host "  status          Check service status and ALB health"
    Write-Host "  on              Start service (2 tasks)"
    Write-Host "  off             Stop service (0 tasks)"
    Write-Host "  ip              Get direct task IP"
    Write-Host "  logs            Tail CloudWatch logs"
    Write-Host "  setup-infra     Create ALB infrastructure (first-time)"
    Write-Host "  setup-scaling   Configure auto-scaling + office hours"
    Write-Host "  update-service  Connect ECS service to ALB"
    exit 0
}

# ============================================================
# HELPER: Get ALB DNS
# ============================================================
function Get-AlbDns {
    try {
        $dns = aws elbv2 describe-load-balancers `
            --names $ALB_NAME `
            --query "LoadBalancers[0].DNSName" `
            --output text `
            --region $REGION
        if ([string]::IsNullOrWhiteSpace($dns) -or $dns -eq "None") { return $null }
        return $dns
    } catch { return $null }
}

function Get-TgArn {
    try {
        $arn = aws elbv2 describe-target-groups `
            --names $TG_NAME `
            --query "TargetGroups[0].TargetGroupArn" `
            --output text `
            --region $REGION
        if ([string]::IsNullOrWhiteSpace($arn) -or $arn -eq "None") { return $null }
        return $arn
    } catch { return $null }
}

# ============================================================
# DEPLOY
# ============================================================
if ($Command -eq "deploy") {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Deploying Log Analyzer" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    # Register task definition
    Write-Host "Registering task definition..." -ForegroundColor Yellow
    aws ecs register-task-definition --cli-input-json file://task-definition.json --region $REGION | Out-Null

    # Build Docker image
    Write-Host "Building Docker image (no cache)..." -ForegroundColor Yellow
    docker build --no-cache -t log-analyzer-prod .

    # Push to ECR
    $ACCOUNT_ID = aws sts get-caller-identity --query Account --output text
    Write-Host "Pushing to ECR ($ACCOUNT_ID)..." -ForegroundColor Yellow
    aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
    docker tag log-analyzer-prod:latest "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/${ECR_REPO}:latest"
    docker push "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/${ECR_REPO}:latest"

    # Force new deployment
    Write-Host "Deploying to ECS..." -ForegroundColor Yellow
    aws ecs update-service --cluster $CLUSTER --service $SERVICE --force-new-deployment --region $REGION | Out-Null

    Write-Host "`nWaiting for deployment to stabilize (2-3 min)..." -ForegroundColor Yellow

    $ALB_DNS = Get-AlbDns
    if (-not $ALB_DNS) {
        Write-Host "ALB not found. Run: .\aws-ops.ps1 setup-infra" -ForegroundColor Red
        exit 1
    }

    # Wait for healthy targets
    $MAX = 36
    $i = 0
    $stable = $false

    while (-not $stable -and $i -lt $MAX) {
        Start-Sleep -Seconds 5
        $i++

        $svc = aws ecs describe-services --cluster $CLUSTER --services $SERVICE --query "services[0]" --region $REGION | ConvertFrom-Json
        if ($svc.runningCount -gt 0) {
            $tgArn = Get-TgArn
            if ($tgArn) {
                $health = aws elbv2 describe-target-health --target-group-arn $tgArn --region $REGION | ConvertFrom-Json
                $healthy = ($health.TargetHealthDescriptions | Where-Object { $_.TargetHealth.State -eq "healthy" }).Count
                if ($healthy -gt 0) {
                    $stable = $true
                    Write-Host "Deployment complete! $healthy healthy targets" -ForegroundColor Green
                } else {
                    Write-Host "  [$i/$MAX] $($svc.runningCount)/$($svc.desiredCount) tasks, waiting for health checks..." -ForegroundColor Cyan
                }
            }
        } else {
            Write-Host "  [$i/$MAX] Waiting for tasks to start..." -ForegroundColor Cyan
        }
    }

    if (-not $stable) {
        Write-Host "`nTimeout - deployment may still be in progress" -ForegroundColor Yellow
        Write-Host "Check: .\aws-ops.ps1 status" -ForegroundColor White
    }

    Write-Host "`nURL: http://$ALB_DNS" -ForegroundColor Green
}

# ============================================================
# STATUS
# ============================================================
elseif ($Command -eq "status") {
    $ErrorActionPreference = "SilentlyContinue"

    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Log Analyzer Status" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    # ECS Service
    $svcJson = aws ecs describe-services --cluster $CLUSTER --services $SERVICE --region $REGION --output json 2>$null
    if ($svcJson) {
        $svc = ($svcJson | ConvertFrom-Json).services[0]
        Write-Host "ECS Service:" -ForegroundColor Yellow
        Write-Host "  Status:  $($svc.status)"
        Write-Host "  Desired: $($svc.desiredCount)"
        Write-Host "  Running: $($svc.runningCount)"

        if ($svc.status -eq "INACTIVE") {
            Write-Host "  State:   INACTIVE" -ForegroundColor Gray
        } elseif ($svc.runningCount -gt 0) {
            Write-Host "  State:   ONLINE" -ForegroundColor Green
        } elseif ($svc.desiredCount -gt 0) {
            Write-Host "  State:   STARTING" -ForegroundColor Yellow
        } else {
            Write-Host "  State:   STOPPED" -ForegroundColor Gray
        }
    } else {
        Write-Host "ECS Service: NOT FOUND" -ForegroundColor Red
    }

    # ALB
    $ALB_DNS = Get-AlbDns
    if ($ALB_DNS) {
        Write-Host "`nALB:" -ForegroundColor Yellow
        Write-Host "  URL: http://$ALB_DNS" -ForegroundColor Cyan

        $tgArn = Get-TgArn
        if ($tgArn) {
            $healthJson = aws elbv2 describe-target-health --target-group-arn $tgArn --region $REGION --output json 2>$null
            if ($healthJson) {
                $health = ($healthJson | ConvertFrom-Json)
                $healthy = @($health.TargetHealthDescriptions | Where-Object { $_.TargetHealth.State -eq "healthy" }).Count
                $unhealthy = @($health.TargetHealthDescriptions | Where-Object { $_.TargetHealth.State -ne "healthy" }).Count
                Write-Host "  Healthy:   $healthy" -ForegroundColor Green
                Write-Host "  Unhealthy: $unhealthy" -ForegroundColor $(if ($unhealthy -gt 0) { "Red" } else { "White" })
            }
        }
    } else {
        Write-Host "`nALB: NOT FOUND" -ForegroundColor Red
    }

    Write-Host ""
}

# ============================================================
# ON
# ============================================================
elseif ($Command -eq "on") {
    Write-Host "Starting service (1 task, SQLite-safe mode)..." -ForegroundColor Yellow
    aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 1 --region $REGION | Out-Null
    Write-Host "Service starting..." -ForegroundColor Green

    $MAX = 30
    $i = 0
    $running = 0

    while ($running -lt 1 -and $i -lt $MAX) {
        Start-Sleep -Seconds 5
        $i++
        $running = aws ecs describe-services --cluster $CLUSTER --services $SERVICE --query "services[0].runningCount" --output text --region $REGION
        Write-Host "  [$i/$MAX] $running/1 task running..." -ForegroundColor Cyan
    }

    if ($running -ge 1) {
        Write-Host "`nService is RUNNING!" -ForegroundColor Green
        $ALB_DNS = Get-AlbDns
        if ($ALB_DNS) {
            Write-Host "URL: http://$ALB_DNS (wait 30-60s for health checks)" -ForegroundColor Cyan
        }
    } else {
        Write-Host "`nTimeout - tasks still starting. Run: .\aws-ops.ps1 status" -ForegroundColor Yellow
    }
}

# ============================================================
# OFF
# ============================================================
elseif ($Command -eq "off") {
    Write-Host "Stopping service (0 tasks)..." -ForegroundColor Yellow
    aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0 --region $REGION | Out-Null

    $MAX = 20
    $i = 0
    $running = -1

    while ($running -ne 0 -and $i -lt $MAX) {
        Start-Sleep -Seconds 3
        $i++
        $running = aws ecs describe-services --cluster $CLUSTER --services $SERVICE --query "services[0].runningCount" --output text --region $REGION
        Write-Host "  [$i/$MAX] $running tasks still running..." -ForegroundColor Cyan
    }

    if ($running -eq 0) {
        Write-Host "`nService STOPPED!" -ForegroundColor Green
    } else {
        Write-Host "`nTimeout - tasks still stopping. Run: .\aws-ops.ps1 status" -ForegroundColor Yellow
    }
}

# ============================================================
# IP (direct task access, bypasses ALB)
# ============================================================
elseif ($Command -eq "ip") {
    $TASK_ARN = aws ecs list-tasks --cluster $CLUSTER --region $REGION --query "taskArns[0]" --output text
    if ([string]::IsNullOrWhiteSpace($TASK_ARN) -or $TASK_ARN -eq "None") {
        Write-Host "No running tasks found" -ForegroundColor Red
        exit 1
    }

    $ENI_ID = aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK_ARN --region $REGION `
        --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text

    if (![string]::IsNullOrWhiteSpace($ENI_ID)) {
        $PUBLIC_IP = aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID `
            --query "NetworkInterfaces[0].Association.PublicIp" --output text
        Write-Host "Task: $TASK_ARN" -ForegroundColor Cyan
        Write-Host "URL:  http://${PUBLIC_IP}:3000" -ForegroundColor Green
    } else {
        Write-Host "Could not find network interface" -ForegroundColor Red
    }
}

# ============================================================
# LOGS
# ============================================================
elseif ($Command -eq "logs") {
    Write-Host "Tailing CloudWatch logs (Ctrl+C to stop)..." -ForegroundColor Yellow
    aws logs tail /ecs/log-analyzer --follow --region $REGION
}

# ============================================================
# SETUP-INFRA (first-time: ALB + Target Group + Security Groups)
# ============================================================
elseif ($Command -eq "setup-infra") {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Creating ALB Infrastructure" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    # Get VPC and subnets
    $VPC_ID = aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text --region $REGION
    Write-Host "VPC: $VPC_ID" -ForegroundColor Cyan

    $SUBNETS = aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query "Subnets[*].SubnetId" --output text --region $REGION
    $SUBNET_LIST = $SUBNETS -replace "`t", " "
    Write-Host "Subnets: $SUBNET_LIST" -ForegroundColor Cyan

    # Create ALB security group (allow port 80 from internet)
    Write-Host "`nCreating ALB security group..." -ForegroundColor Yellow
    try {
        $ALB_SG = aws ec2 create-security-group `
            --group-name "log-analyzer-alb-sg" `
            --description "ALB - allow HTTP from internet" `
            --vpc-id $VPC_ID `
            --region $REGION `
            --query "GroupId" --output text
        aws ec2 authorize-security-group-ingress --group-id $ALB_SG --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $REGION 2>$null
        Write-Host "  ALB SG: $ALB_SG" -ForegroundColor Green
    } catch {
        $ALB_SG = aws ec2 describe-security-groups --filters "Name=group-name,Values=log-analyzer-alb-sg" --query "SecurityGroups[0].GroupId" --output text --region $REGION
        Write-Host "  ALB SG (existing): $ALB_SG" -ForegroundColor Cyan
    }

    # Create ECS security group (allow port 3000 from ALB only)
    Write-Host "Creating ECS security group..." -ForegroundColor Yellow
    try {
        $ECS_SG = aws ec2 create-security-group `
            --group-name "log-analyzer-ecs-sg" `
            --description "ECS tasks - allow traffic from ALB only" `
            --vpc-id $VPC_ID `
            --region $REGION `
            --query "GroupId" --output text
        aws ec2 authorize-security-group-ingress --group-id $ECS_SG --protocol tcp --port 3000 --source-group $ALB_SG --region $REGION 2>$null
        Write-Host "  ECS SG: $ECS_SG" -ForegroundColor Green
    } catch {
        $ECS_SG = aws ec2 describe-security-groups --filters "Name=group-name,Values=log-analyzer-ecs-sg" --query "SecurityGroups[0].GroupId" --output text --region $REGION
        Write-Host "  ECS SG (existing): $ECS_SG" -ForegroundColor Cyan
    }

    # Create ALB
    Write-Host "`nCreating Application Load Balancer..." -ForegroundColor Yellow
    try {
        $ALB_ARN = aws elbv2 create-load-balancer `
            --name $ALB_NAME `
            --subnets $($SUBNET_LIST -split " ") `
            --security-groups $ALB_SG `
            --scheme internet-facing `
            --type application `
            --region $REGION `
            --query "LoadBalancers[0].LoadBalancerArn" --output text
        Write-Host "  ALB created: $ALB_ARN" -ForegroundColor Green
    } catch {
        $ALB_ARN = aws elbv2 describe-load-balancers --names $ALB_NAME --query "LoadBalancers[0].LoadBalancerArn" --output text --region $REGION
        Write-Host "  ALB (existing): $ALB_ARN" -ForegroundColor Cyan
    }

    # Set idle timeout to 1 hour (for long uploads)
    aws elbv2 modify-load-balancer-attributes --load-balancer-arn $ALB_ARN `
        --attributes Key=idle_timeout.timeout_seconds,Value=3600 --region $REGION | Out-Null

    # Create or reuse Target Group
    Write-Host "Creating target group..." -ForegroundColor Yellow
    $TG_ARN = Get-TgArn
    if ($TG_ARN) {
        Write-Host "  TG (existing): $TG_ARN" -ForegroundColor Cyan
        # Update health check settings on existing TG
        aws elbv2 modify-target-group `
            --target-group-arn $TG_ARN `
            --health-check-path "/api/health" `
            --health-check-interval-seconds 30 `
            --healthy-threshold-count 2 `
            --unhealthy-threshold-count 3 `
            --health-check-timeout-seconds 5 `
            --region $REGION | Out-Null
    } else {
        $TG_ARN = aws elbv2 create-target-group `
            --name $TG_NAME `
            --protocol HTTP `
            --port 3000 `
            --vpc-id $VPC_ID `
            --target-type ip `
            --health-check-path "/api/health" `
            --health-check-interval-seconds 30 `
            --healthy-threshold-count 2 `
            --unhealthy-threshold-count 3 `
            --health-check-timeout-seconds 5 `
            --region $REGION `
            --query "TargetGroups[0].TargetGroupArn" --output text
        Write-Host "  TG created: $TG_ARN" -ForegroundColor Green
    }

    # Set deregistration delay to 30s + enable ALB cookie stickiness
    aws elbv2 modify-target-group-attributes --target-group-arn $TG_ARN `
        --attributes `
            Key=deregistration_delay.timeout_seconds,Value=30 `
            Key=stickiness.enabled,Value=true `
            Key=stickiness.type,Value=lb_cookie `
            Key=stickiness.lb_cookie.duration_seconds,Value=86400 `
        --region $REGION | Out-Null

    # Create listener
    Write-Host "Creating HTTP listener..." -ForegroundColor Yellow
    try {
        aws elbv2 create-listener `
            --load-balancer-arn $ALB_ARN `
            --protocol HTTP `
            --port 80 `
            --default-actions Type=forward,TargetGroupArn=$TG_ARN `
            --region $REGION | Out-Null
        Write-Host "  Listener created" -ForegroundColor Green
    } catch {
        Write-Host "  Listener (existing)" -ForegroundColor Cyan
    }

    $ALB_DNS = Get-AlbDns
    Write-Host "`nALB Infrastructure Ready!" -ForegroundColor Green
    Write-Host "URL: http://$ALB_DNS" -ForegroundColor Cyan
    Write-Host "`nNext: .\aws-ops.ps1 update-service" -ForegroundColor Yellow
}

# ============================================================
# UPDATE-SERVICE (connect ECS service to ALB target group)
# ============================================================
elseif ($Command -eq "update-service") {
    Write-Host "Connecting ECS service to ALB..." -ForegroundColor Yellow

    $TG_ARN = Get-TgArn
    if (-not $TG_ARN) {
        Write-Host "Target group not found. Run: .\aws-ops.ps1 setup-infra" -ForegroundColor Red
        exit 1
    }

    $ECS_SG = aws ec2 describe-security-groups --filters "Name=group-name,Values=log-analyzer-ecs-sg" `
        --query "SecurityGroups[0].GroupId" --output text --region $REGION

    $SUBNETS = aws ec2 describe-subnets `
        --filters "Name=vpc-id,Values=$(aws ec2 describe-vpcs --filters 'Name=isDefault,Values=true' --query 'Vpcs[0].VpcId' --output text --region $REGION)" `
        --query "Subnets[*].SubnetId" --output text --region $REGION

    # Delete and recreate service with ALB attachment
    Write-Host "Recreating service with ALB attachment..." -ForegroundColor Yellow

    try { aws ecs delete-service --cluster $CLUSTER --service $SERVICE --force --region $REGION | Out-Null } catch {}
    Start-Sleep -Seconds 10

    $subnetArray = ($SUBNETS -split "`t") -join ","

    aws ecs create-service `
        --cluster $CLUSTER `
        --service-name $SERVICE `
        --task-definition log-analyzer-task `
        --desired-count 1 `
        --launch-type FARGATE `
        --network-configuration "awsvpcConfiguration={subnets=[$subnetArray],securityGroups=[$ECS_SG],assignPublicIp=ENABLED}" `
        --load-balancers "targetGroupArn=$TG_ARN,containerName=log-analyzer,containerPort=3000" `
        --health-check-grace-period-seconds 120 `
        --region $REGION | Out-Null

    Write-Host "Service created with ALB!" -ForegroundColor Green
    Write-Host "Next: .\aws-ops.ps1 setup-scaling" -ForegroundColor Yellow
}

# ============================================================
# SETUP-SCALING (auto-scaling + office hours schedule)
# ============================================================
elseif ($Command -eq "setup-scaling") {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Configuring Auto-Scaling" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    # --- EDIT THESE ---
    $OFFICE_START_HOUR = 7    # 7 AM
    $OFFICE_END_HOUR   = 17   # 5 PM
    $TIMEZONE          = "Europe/Helsinki"
    $MIN_TASKS         = 1
    $MAX_TASKS         = 1
    # ------------------

    $RESOURCE_ID = "service/$CLUSTER/$SERVICE"

    # Register scalable target
    Write-Host "Registering scalable target..." -ForegroundColor Yellow
    aws application-autoscaling register-scalable-target `
        --service-namespace ecs `
        --resource-id $RESOURCE_ID `
        --scalable-dimension "ecs:service:DesiredCount" `
        --min-capacity $MIN_TASKS `
        --max-capacity $MAX_TASKS `
        --region $REGION

    if ($MIN_TASKS -eq $MAX_TASKS) {
        Write-Host "Skipping auto-scale policies (SQLite-safe single-task mode)." -ForegroundColor Yellow
    } else {
        # CPU-based scaling
        Write-Host "Adding CPU scaling policy..." -ForegroundColor Yellow
        aws application-autoscaling put-scaling-policy `
            --service-namespace ecs `
            --resource-id $RESOURCE_ID `
            --scalable-dimension "ecs:service:DesiredCount" `
            --policy-name "log-analyzer-cpu-scaling" `
            --policy-type TargetTrackingScaling `
            --target-tracking-scaling-policy-configuration "TargetValue=70,PredefinedMetricSpecification={PredefinedMetricType=ECSServiceAverageCPUUtilization},ScaleInCooldown=600,ScaleOutCooldown=120" `
            --region $REGION | Out-Null

        # Memory-based scaling
        Write-Host "Adding memory scaling policy..." -ForegroundColor Yellow
        aws application-autoscaling put-scaling-policy `
            --service-namespace ecs `
            --resource-id $RESOURCE_ID `
            --scalable-dimension "ecs:service:DesiredCount" `
            --policy-name "log-analyzer-memory-scaling" `
            --policy-type TargetTrackingScaling `
            --target-tracking-scaling-policy-configuration "TargetValue=75,PredefinedMetricSpecification={PredefinedMetricType=ECSServiceAverageMemoryUtilization},ScaleInCooldown=600,ScaleOutCooldown=120" `
            --region $REGION | Out-Null
    }

    # Office hours: scale up at start, scale down at end (Mon-Fri)
    Write-Host "Setting office hours schedule ($OFFICE_START_HOUR:00 - ${OFFICE_END_HOUR}:00 $TIMEZONE)..." -ForegroundColor Yellow

    aws application-autoscaling put-scheduled-action `
        --service-namespace ecs `
        --resource-id $RESOURCE_ID `
        --scalable-dimension "ecs:service:DesiredCount" `
        --scheduled-action-name "office-hours-start" `
        --schedule "cron($OFFICE_START_HOUR 0 ? * MON-FRI *)" `
        --timezone $TIMEZONE `
        --scalable-target-action "MinCapacity=$MIN_TASKS,MaxCapacity=$MAX_TASKS" `
        --region $REGION | Out-Null

    aws application-autoscaling put-scheduled-action `
        --service-namespace ecs `
        --resource-id $RESOURCE_ID `
        --scalable-dimension "ecs:service:DesiredCount" `
        --scheduled-action-name "office-hours-end" `
        --schedule "cron($OFFICE_END_HOUR 0 ? * MON-FRI *)" `
        --timezone $TIMEZONE `
        --scalable-target-action "MinCapacity=0,MaxCapacity=0" `
        --region $REGION | Out-Null

    Write-Host "`nAuto-scaling configured!" -ForegroundColor Green
    Write-Host "  Office hours: Mon-Fri $OFFICE_START_HOUR:00 - ${OFFICE_END_HOUR}:00 ($TIMEZONE)" -ForegroundColor Cyan
    Write-Host "  Tasks: $MIN_TASKS - $MAX_TASKS (during office hours), 0 (off hours)" -ForegroundColor Cyan
    if ($MIN_TASKS -eq $MAX_TASKS) {
        Write-Host "  Auto-scaling: disabled (single-task SQLite-safe mode)" -ForegroundColor Cyan
    } else {
        Write-Host "  CPU scale-up: >70%, Memory scale-up: >75%" -ForegroundColor Cyan
    }
}
