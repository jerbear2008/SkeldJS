import { Vector2 } from "@skeldjs/util";

import {
    CustomNetworkTransform,
    PlayerData,
    PlayerDataResolvable,
    TheSkeldVent,
    MiraHQVent,
    PolusVent,
    MapVentData,
    Hostable,
} from "@skeldjs/core";

import { EventContext, EventEmitter } from "@skeldjs/events";

import fs from "fs";
import path from "path";

import { PathfinderConfig } from "./interface/PathfinderConfig";
import { Grid } from "./util/Grid";
import { Node } from "./util/Node";

import { getShortestPath } from "./engine";

interface SkeldjsPathfinderEvents {
    /**
     * Emitted when the pathfinder starts or is resumed.
     */
    "pathfinding.start": {
        /**
         * The destination of the pathfinder.
         */
        destination: Vector2;
    };
    /**
     * Emitted when the pathfinder stops.
     */
    "pathfinding.stop": {
        /**
         * Whether or not the pathfinder reached its intended destination.
         */
        reached: boolean;
    };
    /**
     * Emitted when the pathfinder reaches its intended destination.
     */
    "pathfinding.end": {};
    /**
     * Emitted when the pathfinder is paused.
     */
    "pathfinding.pause": {};
    /**
     * Emitted when the engine intends to make a move.
     */
    "engine.move": {
        /**
         * The position the engine intends to move to.
         */
        position: Vector2;
    };
    /**
     * Emitted when the engine recalculates a path.
     */
    "engine.recalculate": {
        /**
         * The path that the engine intends to take.
         */
        path: Vector2[];
    };
}

/**
 * Represents a pathfinding utility for the {@link SkeldjsClient SkeldJS Client}.
 *
 * See {@link SkeldjsPathfinderEvents} for events to listen to.
 */
export class SkeldjsPathfinder extends EventEmitter<SkeldjsPathfinderEvents> {
    private _tick: number;
    private _moved: boolean;
    private _paused: boolean;

    /**
     * The destination of the pathfinder.
     */
    destination: Vector2;

    /**
     * The grid of nodes for the pathfinder engine.
     */
    grid: Grid;

    /**
     * The current intended path of the pathfinder.
     */
    path: Node[];

    /**
     * The player that the pathfinder is currently finding.
     */
    following: PlayerData;

    constructor(
        private client: Hostable,
        public config: PathfinderConfig = {}
    ) {
        super();

        this._tick = 0;
        this.client.on("room.fixedupdate", this._ontick.bind(this));
        this.client.on("player.move", this._handleMove.bind(this));
        this.client.on("player.leave", this._handleLeave.bind(this));
    }

    private get snode() {
        if (!this.position) return null;

        return this.grid.nearest(this.position.x, this.position.y);
    }

    private get dnode() {
        if (!this.destination) return null;

        return this.grid.nearest(this.destination.x, this.destination.y);
    }

    get position() {
        return this.transform?.position;
    }

    get transform(): CustomNetworkTransform {
        return this.me?.transform;
    }

    get me() {
        return this.room?.me;
    }

    get room() {
        return this.client?.room;
    }

    get map() {
        return this.room?.settings?.map;
    }

    get paused() {
        return this._paused;
    }

    private async _ontick() {
        this._tick++;

        if (this._tick % SkeldjsPathfinder.MovementInterval !== 0) return;

        if (typeof this.map === "undefined") return;

        if (!this.grid) {
            const buff = fs.readFileSync(
                path.resolve(__dirname, "../../data/build", "" + this.map)
            );
            this.grid = Grid.fromBuffer(buff);
        }

        if (!this.snode || !this.dnode) return;

        if (
            this._moved ||
            !this.path ||
            this._tick % (this.config.recalculateEvery || 1) === 0
        ) {
            await this.recalculate();
            this._moved = false;
        }

        if (this._paused) return;

        const next = this.path.shift();

        if (next) {
            const pos = this.grid.actual(next.x, next.y);
            const dist = Math.hypot(
                this.position.x - pos.x,
                this.position.y - pos.y
            );
            if (await this.emit("engine.move", { position: pos })) {
                this.transform.move(pos, {
                    x: dist * this.client.settings.playerSpeed,
                    y: dist * this.client.settings.playerSpeed,
                });
            }

            if (this.path.length === 0) {
                this._stop(true);
            }
        } else {
            this.destination = null;
            this.path = null;
        }
    }

    async recalculate() {
        this.grid.reset();
        this.path = getShortestPath(this.grid, this.snode, this.dnode);
        await this.emit("engine.recalculate", {
            path: this.path.map((node) => this.grid.actual(node.x, node.y)),
        });
    }

    pause() {
        this._paused = true;
        this.emit("pathfinding.pause", {});
    }

    start() {
        this._paused = false;
        this.emit("pathfinding.start", {
            destination: this.destination,
        });
    }

    private _stop(reached: boolean) {
        this.destination = null;
        if (!reached) this._moved = true;

        this.emit("pathfinding.stop", { reached });
        if (reached) {
            this.emit("pathfinding.end", {});
        }
    }

    stop() {
        this._stop(false);
    }

    private _go(dest: Vector2) {
        this.destination = {
            // Recreate object to not recalculate new player position after moving.
            x: dest.x,
            y: dest.y,
        };
        this._moved = true;
        this.start();
    }

    go(pos: PlayerDataResolvable | Vector2 | Node) {
        const vec = pos as Vector2;

        if (vec.x) {
            this._go(vec);
            return;
        }

        if (pos instanceof Node) {
            return this.grid.actual(pos.x, pos.y);
        }

        const resolved = this.client?.room?.resolvePlayer(
            pos as PlayerDataResolvable
        );

        if (resolved && resolved.spawned) {
            const position = resolved.transform.position;

            return this.go(position);
        }
    }

    vent(ventid: TheSkeldVent | MiraHQVent | PolusVent) {
        if (!this.map) return;

        const coords = MapVentData[this.map][ventid];

        this.go(coords.position);
    }

    private _handleMove(
        ev: EventContext<{
            component: CustomNetworkTransform;
            position: Vector2;
        }>
    ) {
        if (ev.data.component.owner === this.following) {
            this.destination = {
                x: ev.data.position.x,
                y: ev.data.position.y,
            };
            this._moved = true;
        }
    }

    private _handleLeave(ev: EventContext<{ player: PlayerData }>) {
        if (ev.data.player === this.following) {
            this._stop(false);
            this.following = null;
        }
    }

    follow(player: PlayerDataResolvable) {
        const resolved = this.client?.room?.resolvePlayer(player);

        if (resolved && resolved.spawned) {
            this.following = resolved;
        }
    }

    static MovementInterval = 6 as const;
}
