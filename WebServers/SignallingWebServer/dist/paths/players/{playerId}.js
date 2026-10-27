"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;
/* eslint-disable @typescript-eslint/no-unsafe-argument,
                  @typescript-eslint/no-unsafe-call,
                  @typescript-eslint/no-unsafe-member-access */
function default_1(signallingServer) {
    const operations = {
        GET
    };
    function GET(req, res, _next) {
        const player = signallingServer.playerRegistry.get(req.params.playerId);
        if (!player) {
            res.status(404).json({ message: `No player ID matches ${req.params.playerId}.` });
            return;
        }
        res.status(200).json(player.getPlayerInfo());
    }
    GET.apiDoc = {
        summary: 'Returns a single player',
        operationId: 'getOnePlayer',
        parameters: [
            {
                name: 'playerId',
                in: 'path',
                required: true,
                schema: {
                    type: 'string'
                }
            }
        ],
        responses: {
            200: {
                description: 'Player data',
                content: {
                    'application/json': {
                        schema: {
                            $ref: '#/components/schemas/Player'
                        }
                    }
                }
            }
        }
    };
    return operations;
}
