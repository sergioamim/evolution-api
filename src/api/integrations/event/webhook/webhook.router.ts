import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { EventDto } from '@api/integrations/event/event.dto';
import type { WebhookController } from '@api/integrations/event/webhook/webhook.controller';
import { HttpStatus } from '@api/routes/http-status';
import { ConfigService } from '@config/env.config';
import { instanceSchema, webhookSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

export class WebhookRouter extends RouterBroker {
  constructor(
    readonly configService: ConfigService,
    readonly controller: Pick<WebhookController, 'set' | 'get'>,
    ...guards: RequestHandler[]
  ) {
    super();
    this.router
      .post(this.routerPath('set'), ...guards, async (req, res) => {
        const response = await this.dataValidate<EventDto>({
          request: req,
          schema: webhookSchema,
          ClassRef: EventDto,
          execute: (instance, data) => controller.set(instance.instanceName, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => controller.get(instance.instanceName),
        });

        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
