import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CoyoteStack } from '../lib/coyote-stack';

describe('CoyoteStack', () => {
  it('synthesizes in domainless mode without credentials', () => {
    const stack = new CoyoteStack(new App(), 'Coyote-test', {
      env: { region: 'us-east-1' },
      envName: 'dev',
    });
    expect(Template.fromStack(stack).toJSON()).toBeDefined();
  });

  it('rejects a half-configured domain setup', () => {
    expect(
      () =>
        new CoyoteStack(new App(), 'Coyote-test', {
          env: { region: 'us-east-1' },
          envName: 'dev',
          domainName: 'example.com',
        }),
    ).toThrow(/domainless/);
  });
});
