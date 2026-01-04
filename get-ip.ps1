$TASK_ARN = aws ecs list-tasks --cluster log-analyzer-cluster --region eu-north-1 --query "taskArns[0]" --output text
echo "Task ARN: '$TASK_ARN'"

if ([string]::IsNullOrWhiteSpace($TASK_ARN) -or $TASK_ARN -eq "None") {
    echo "No task found - checking tasks list:"
    aws ecs list-tasks --cluster log-analyzer-cluster --region eu-north-1
} else {
    echo "Getting network interface..."
    $ENI_ID = aws ecs describe-tasks --cluster log-analyzer-cluster --tasks $TASK_ARN --region eu-north-1 --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text
    echo "ENI: '$ENI_ID'"
    
    if (![string]::IsNullOrWhiteSpace($ENI_ID)) {
        $PUBLIC_IP = aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID --query "NetworkInterfaces[0].Association.PublicIp" --output text
        echo "Public IP: '$PUBLIC_IP'"
        echo ""
        echo "🚀 http://$PUBLIC_IP:3000"
    }
}