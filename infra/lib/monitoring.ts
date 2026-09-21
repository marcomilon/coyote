import {
  Duration,
  Stack,
  aws_apigatewayv2 as apigwv2,
  aws_budgets as budgets,
  aws_ce as ce,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as actions,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_sns as sns,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface MonitoringProps {
  api: apigwv2.HttpApi;
  generate: lambda.IFunction;
  /** Visitor reports go here (one email per report). */
  abuseReports: sns.Topic;
  monthlyBudgetUsd: number;
}

/**
 * Abuse and cost detection. Every alarm goes to the `alerts` topic.
 * Email subscriptions are NOT created here: an email subscription must be confirmed through the API with
 * AuthenticateOnUnsubscribe, or any mail scanner that follows the unsubscribe link silently removes it.
 * Use `./coyote.sh subscribe-alerts <email>` and `./coyote.sh confirm-alerts '<link>'`.
 * The Lambdas write the "Coyote" metrics as EMF log lines (services/generator/src/core/metrics.ts).
 */
export class Monitoring extends Construct {
  readonly alerts: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    const stack = Stack.of(this);

    this.alerts = new sns.Topic(this, 'Alerts', { displayName: 'Coyote alerts' });
    // AWS Budgets and Cost Anomaly Detection publish to the topic themselves.
    this.alerts.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com'), new iam.ServicePrincipal('costalerts.amazonaws.com')],
        resources: [this.alerts.topicArn],
      }),
    );

    const metric = (metricName: string, period = Duration.hours(1)) =>
      new cw.Metric({ namespace: 'Coyote', metricName, statistic: 'Sum', period });
    const apiMetric = (metricName: string) =>
      new cw.Metric({ namespace: 'AWS/ApiGateway', metricName, dimensionsMap: { ApiId: props.api.apiId }, statistic: 'Sum', period: Duration.minutes(5) });

    const alarm = (name: string, description: string, m: cw.IMetric, threshold: number, evaluationPeriods = 1) => {
      const a = new cw.Alarm(this, name, {
        alarmDescription: description,
        metric: m,
        threshold,
        evaluationPeriods,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(new actions.SnsAction(this.alerts));
      return a;
    };

    alarm('PublishRate', 'More sites published in an hour than normal. Run ./coyote.sh abuse-report.', metric('Published'), 20);
    alarm('RateLimited', 'Someone keeps hitting the per-IP limit.', metric('RateLimited'), 20);
    alarm('Rejected', 'Many rejected requests in an hour: someone is probing the safety filters.', metric('Rejected'), 15);
    alarm('GenerationFailures', 'Generations are failing.', metric('Failed'), 3);
    alarm('Quarantined', 'A site was taken offline by visitor reports.', metric('Quarantined'), 0);
    alarm(
      'TokensPerDay',
      'Model tokens per day are above budget.',
      new cw.MathExpression({ expression: 'tin + tout', usingMetrics: { tin: metric('TokensIn', Duration.days(1)), tout: metric('TokensOut', Duration.days(1)) }, period: Duration.days(1) }),
      2_000_000,
    );
    alarm('GenerateErrors', 'The generate Lambda crashed or timed out.', props.generate.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }), 0);
    alarm('Api5xx', 'The API is returning server errors.', apiMetric('5xx'), 5);
    alarm('Api4xx', 'Unusual number of client errors (includes 422 and 429).', apiMetric('4xx'), 200);

    new cw.Dashboard(this, 'Dashboard', {
      dashboardName: 'Coyote',
      widgets: [
        [
          new cw.GraphWidget({ title: 'Requests', width: 12, left: [metric('Submitted'), metric('Generated'), metric('Published')] }),
          new cw.GraphWidget({ title: 'Blocked', width: 12, left: [metric('Rejected'), metric('RateLimited'), metric('Failed'), metric('Reported'), metric('Quarantined')] }),
        ],
        [
          new cw.GraphWidget({ title: 'Model tokens per hour', width: 12, left: [metric('TokensIn'), metric('TokensOut')] }),
          new cw.GraphWidget({ title: 'API', width: 12, left: [apiMetric('Count'), apiMetric('4xx'), apiMetric('5xx')] }),
        ],
      ],
    });

    new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: 'coyote-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [80, 100].map((threshold) => ({
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'SNS', address: this.alerts.topicArn }],
      })),
    });

    // Catches what a fixed budget misses at low volume: spend that deviates from the usual pattern.
    const monitor = new ce.CfnAnomalyMonitor(this, 'CostAnomalyMonitor', {
      monitorName: 'coyote-services',
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });
    new ce.CfnAnomalySubscription(this, 'CostAnomalySubscription', {
      subscriptionName: 'coyote-cost-anomalies',
      frequency: 'IMMEDIATE',
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ type: 'SNS', address: this.alerts.topicArn }],
      thresholdExpression: JSON.stringify({
        Dimensions: { Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE', MatchOptions: ['GREATER_THAN_OR_EQUAL'], Values: ['5'] },
      }),
    });
    void stack;
  }
}
