/**
 * The `/iam` surface (Doc 06 §4–12).
 *
 * Only the RLS probe today. Sessions 7 onwards add the registry, tenant,
 * scope, role, user, binding and resolution controllers here.
 */

import { Module } from '@nestjs/common';
import { WhoAmIController } from './whoami.controller';

@Module({
  controllers: [WhoAmIController],
})
export class IamModule {}
