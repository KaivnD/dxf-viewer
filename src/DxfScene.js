import {DynamicBuffer, NativeType} from "./DynamicBuffer"
import "./RBTree"
import {BatchingKey} from "./BatchingKey"
import {Matrix3, Vector2} from "three"
import {TextRenderer} from "./TextRenderer"

/** Use 16-bit indices for indexed geometry. */
const INDEXED_CHUNK_SIZE = 0x10000
/** Arc angle for tessellating point circle shape. */
const POINT_CIRCLE_TESSELLATION_ANGLE = 15 * Math.PI / 180
const POINT_SHAPE_BLOCK_NAME = "__point_shape"

/** This class prepares an internal representation of a DXF file, optimized fo WebGL rendering. It
 * is decoupled in such a way so that it should be possible to build it in a web-worker, effectively
 * transfer it to the main thread, and easily apply it to a Three.js scene there.
 */
export class DxfScene {

    constructor(options) {
        this.options = Object.create(DxfScene.DefaultOptions)
        if (options) {
            Object.assign(this.options, options.sceneOptions)
        }

        /* Scene origin. All input coordinates are made local to this point to minimize precision
        * loss.
        */
        this.origin = null
        /* RBTree<BatchingKey, RenderBatch> */
        this.batches = new RBTree((b1, b2) => b1.key.Compare(b2.key))
        /* Indexed by layer name, value is layer object from parsed DXF. */
        this.layers = new Map()
        /* Indexed by block name, value is Block. */
        this.blocks = new Map()
        this.bounds = null
        this.pointShapeBlock = null
    }

    /** Build the scene from the provided parsed DXF.
     * @param dxf {{}} Parsed DXF file.
     * @param fonts {Font[]} List of fonts to use.
     */
    Build(dxf, fonts) {

        this.textRenderer = new TextRenderer(fonts, this.options.textOptions)

        /* 0 - CCW, 1 - CW */
        this.angBase = dxf.header["$ANGBASE"] || 0
        /* Zero angle direction, 0 is +X */
        this.angDir = dxf.header["$ANGDIR"] || 0
        this.pdMode = dxf.header["$PDMODE"] || 0
        this.pdSize = dxf.header["$PDSIZE"] || 0

        if(dxf.tables && dxf.tables.layer) {
            for (const [, layer] of Object.entries(dxf.tables.layer.layers)) {
                this.layers.set(layer.name, layer)
            }
        }

        if (dxf.blocks) {
            for (const [, block] of Object.entries(dxf.blocks)) {
                this.blocks.set(block.name, new Block(block))
            }
        }

        /* Scan all entities to analyze block usage statistics. */
        for (const entity of dxf.entities) {
            if (entity.type === "INSERT") {
                const block = this.blocks.get(entity.name)
                block?.RegisterInsert(entity)
            }
        }

        for (const block of this.blocks.values()) {
            if (block.data.hasOwnProperty("entities")) {
                const blockCtx = block.DefinitionContext()
                for (const entity of block.data.entities) {
                    this._ProcessDxfEntity(entity, blockCtx)
                }
            }
        }

        for (const entity of dxf.entities) {
            this._ProcessDxfEntity(entity)
        }

        this.scene = this._BuildScene()

        delete this.batches
        delete this.layers
        delete this.blocks
        delete this.textRenderer
    }

    _ProcessDxfEntity(entity, blockCtx = null) {
        let renderEntities
        switch (entity.type) {
        case "LINE":
            renderEntities = this._DecomposeLine(entity, blockCtx)
            break
        case "POLYLINE":
        case "LWPOLYLINE":
            renderEntities = this._DecomposePolyline(entity, blockCtx)
            break
        case "ARC":
            renderEntities = this._DecomposeArc(entity, blockCtx)
            break
        case "CIRCLE":
            renderEntities = this._DecomposeCircle(entity, blockCtx)
            break
        case "POINT":
            renderEntities = this._DecomposePoint(entity, blockCtx)
            break
        case "INSERT":
            /* Works with rendering batches without intermediate entities. */
            this._ProcessInsert(entity, blockCtx)
            return
        case "TEXT":
            renderEntities = this._DecomposeText(entity, blockCtx)
            break
        default:
            console.log("Unhandled entity type: " + entity.type)
            return
        }
        for (const renderEntity of renderEntities) {
            this._ProcessEntity(renderEntity, blockCtx)
        }
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessEntity(entity, blockCtx = null) {
        switch (entity.type) {
        case Entity.Type.POINTS:
            this._ProcessPoints(entity, blockCtx)
            break
        case Entity.Type.LINE_SEGMENTS:
            this._ProcessLineSegments(entity, blockCtx)
            break
        case Entity.Type.POLYLINE:
            this._ProcessPolyline(entity, blockCtx)
            break
        case Entity.Type.TRIANGLES:
            this._ProcessTriangles(entity, blockCtx)
            break
        default:
            throw new Error("Unhandled entity type: " + entity.type)
        }
    }

    /**
     * @param entity
     * @param vertex
     * @param blockCtx {?BlockContext}
     * @return {number}
     */
    _GetLineType(entity, vertex = null, blockCtx = null) {
        //XXX lookup
        return 0
    }

    /** Check if start/end with are not specified. */
    _IsPlainLine(entity) {
        return !Boolean(entity.startWidth || entity.endWidth)
    }

    *_DecomposeLine(entity, blockCtx) {
        /* start/end width, bulge - seems cannot be present, at least with current parser */
        if (entity.vertices.length !== 2) {
            return
        }
        const layer = this._GetEntityLayer(entity, blockCtx)
        const color = this._GetEntityColor(entity, blockCtx)
        yield new Entity({
                             type: Entity.Type.LINE_SEGMENTS,
                             vertices: entity.vertices,
                             layer, color,
                             lineType: this._GetLineType(entity, entity.vertices[0])
                         })
    }

    /** Generate vertices for bulged line segment.
     *
     * @param vertices Generated vertices pushed here.
     * @param startVtx Starting vertex. Assuming it is already present in the vertices array.
     * @param endVtx Ending vertex.
     * @param bulge Bulge value (see DXF specification).
     */
    _GenerateBulgeVertices(vertices, startVtx, endVtx, bulge) {
        const a = 4 * Math.atan(bulge)
        const aAbs = Math.abs(a)
        if (aAbs < this.options.arcTessellationAngle) {
            vertices.push(endVtx)
            return
        }
        const ha = a / 2
        const sha = Math.sin(ha)
        const cha = Math.cos(ha)
        const d = {x: endVtx.x - startVtx.x, y: endVtx.y - startVtx.y}
        const dSq = d.x * d.x + d.y * d.y
        if (dSq < Number.MIN_VALUE * 2) {
            /* No vertex is pushed since end vertex is duplicate of start vertex. */
            return
        }
        const D = Math.sqrt(dSq)
        let R = D / 2 / sha
        d.x /= D
        d.y /= D
        const center = {
            x: (d.x * sha - d.y * cha) * R + startVtx.x,
            y: (d.x * cha + d.y * sha) * R + startVtx.y
        }

        let numSegments = Math.floor(aAbs / this.options.arcTessellationAngle)
        if (numSegments > 1) {
            const startAngle = Math.atan2(startVtx.y - center.y, startVtx.x - center.x)
            const step = a / numSegments
            if (a < 0) {
                R = -R
            }
            for (let i = 1; i < numSegments; i++) {
                const a = startAngle + i * step
                const v = {
                    x: center.x + R * Math.cos(a),
                    y: center.y + R * Math.sin(a)
                }
                vertices.push(v)
            }
        }
        vertices.push(endVtx)
    }

    /** Generate vertices for arc segment.
     *
     * @param vertices Generated vertices pushed here.
     * @param center {{x, y}} Center vector.
     * @param radius {number}
     * @param startAngle {?number} Start angle. Zero if not specified. Arc is drawn in CCW direction
     *  from start angle towards end angle.
     * @param endAngle {?number} Optional end angle. Full circle is drawn if not specified.
     * @param tessellationAngle {?number} Arc tessellation angle, default value is taken from scene
     *  options.
     */
    _GenerateArcVertices(vertices, center, radius, startAngle = null, endAngle = null,
                         tessellationAngle = null) {
        if (!center || !radius) {
            return
        }
        if (!tessellationAngle) {
            tessellationAngle = this.options.arcTessellationAngle
        }
        /* Normalize angles - make them starting from +X in CCW direction. End angle should be
         * greater than start angle.
         */
        if (startAngle === undefined || startAngle === null) {
            startAngle = 0
        } else {
            startAngle += this.angBase
        }
        let isClosed = false
        if (endAngle === undefined || endAngle === null) {
            endAngle = startAngle + 2 * Math.PI
            isClosed = true
        } else {
            endAngle += this.angBase
        }
        if (this.angDir) {
            const tmp = startAngle
            startAngle = endAngle
            endAngle = tmp
        }
        while (endAngle <= startAngle) {
            endAngle += Math.PI * 2
        }

        const arcAngle = endAngle - startAngle
        let numSegments = Math.floor(arcAngle / tessellationAngle)
        if (numSegments === 0) {
            numSegments = 1
        }
        const step = arcAngle / numSegments
        for (let i = 0; i <= numSegments; i++) {
            if (i === numSegments && isClosed) {
                break
            }
            const a = startAngle + i * step
            const v = {
                x: center.x + radius * Math.cos(a),
                y: center.y + radius * Math.sin(a)
            }
            vertices.push(v)
        }
    }

    *_DecomposeArc(entity, blockCtx) {
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const lineType = this._GetLineType(entity, null, blockCtx)
        const vertices = []
        this._GenerateArcVertices(vertices, entity.center, entity.radius, entity.startAngle,
                                  entity.endAngle)
        yield new Entity({
                             type: Entity.Type.POLYLINE,
                             vertices, layer, color, lineType,
                             shape: entity.endAngle === undefined
                         })
    }

    *_DecomposeCircle(entity, blockCtx) {
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const lineType = this._GetLineType(entity, null, blockCtx)
        const vertices = []
        this._GenerateArcVertices(vertices, entity.center, entity.radius)
        yield new Entity({
                             type: Entity.Type.POLYLINE,
                             vertices, layer, color, lineType,
                             shape: true
                         })
    }

    *_DecomposePoint(entity, blockCtx) {
        if (this.pdMode === PdMode.NONE) {
            /* Points not displayed. */
            return
        }
        if (this.pdSize <= 0) {
            /* Currently not supported. */
            return
        }
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const markType = this.pdMode & PdMode.MARK_MASK
        const isShaped = (this.pdMode & PdMode.SHAPE_MASK) !== 0

        if (isShaped) {
            /* Shaped mark should be instanced. */
            const key = new BatchingKey(layer, POINT_SHAPE_BLOCK_NAME,
                                        BatchingKey.GeometryType.POINT_INSTANCE, color, 0)
            const batch = this._GetBatch(key)
            batch.PushVertex(this._TransformVertex(entity.position))
            this._CreatePointShapeBlock()
            return
        }

        if (markType === PdMode.DOT) {
            yield new Entity({
                                 type: Entity.Type.POINTS,
                                 vertices: [entity.position],
                                 layer, color,
                                 lineType: null
                             })
            return
        }

        const vertices = []
        this._CreatePointMarker(vertices, markType, entity.position)
        yield new Entity({
                             type: Entity.Type.LINE_SEGMENTS,
                             vertices, layer, color,
                             lineType: null
                         })
    }

    /** Create line segments for point marker.
     * @param vertices
     * @param markType
     * @param position {?{x,y}} point center position, default is zero.
     */
    _CreatePointMarker(vertices, markType, position = null) {
        const _this = this
        function PushVertex(offsetX, offsetY) {
            vertices.push({
                x: (position?.x ?? 0) + offsetX * _this.pdSize * 0.5,
                y: (position?.y ?? 0) + offsetY * _this.pdSize * 0.5
            })
        }

        switch(markType) {
        case PdMode.PLUS:
            PushVertex(0, 1.5)
            PushVertex(0, -1.5)
            PushVertex(-1.5, 0)
            PushVertex(1.5, 0)
            break
        case PdMode.CROSS:
            PushVertex(-1, 1)
            PushVertex(1, -1)
            PushVertex(1, 1)
            PushVertex(-1, -1)
            break
        case PdMode.TICK:
            PushVertex(0, 1)
            PushVertex(0, 0)
            break
        default:
            console.warn("Unsupported point display type: " + markType)
        }
    }

    /** Create point shape block if not yet done. */
    _CreatePointShapeBlock() {
        if (this.pointShapeBlock) {
            return
        }
        /* This mimics DXF block entity. */
        this.pointShapeBlock = new Block({
            name: POINT_SHAPE_BLOCK_NAME,
            position: { x: 0, y: 0}
        })
        const blockCtx = this.pointShapeBlock.DefinitionContext()

        const markType = this.pdMode & PdMode.MARK_MASK
        if (markType !== PdMode.DOT && markType !== PdMode.NONE) {
            const vertices = []
            this._CreatePointMarker(vertices, markType)
            const entity = new Entity({
                                          type: Entity.Type.LINE_SEGMENTS,
                                          vertices,
                                          color: ColorCode.BY_BLOCK
                                      })
            this._ProcessEntity(entity, blockCtx)
        }

        if (this.pdMode & PdMode.SQUARE) {
            const r = this.pdSize * 0.5
            const vertices = [
                {x: -r, y: r},
                {x: r, y: r},
                {x: r, y: -r},
                {x: -r, y: -r}
            ]
            const entity = new Entity({
                                          type: Entity.Type.POLYLINE, vertices,
                                          color: ColorCode.BY_BLOCK,
                                          shape: true
                                      })
            this._ProcessEntity(entity, blockCtx)
        }
        if (this.pdMode & PdMode.CIRCLE) {
            const vertices = []
            this._GenerateArcVertices(vertices, {x: 0, y: 0}, this.pdSize * 0.5, null, null,
                                      POINT_CIRCLE_TESSELLATION_ANGLE)
            const entity = new Entity({
                                          type: Entity.Type.POLYLINE, vertices,
                                          color: ColorCode.BY_BLOCK,
                                          shape: true
                                      })
            this._ProcessEntity(entity, blockCtx)
        }
    }

    *_DecomposeText(entity, blockCtx) {
        if (!this.textRenderer.canRender) {
            return
        }
        const layer = this._GetEntityLayer(entity, blockCtx)
        const color = this._GetEntityColor(entity, blockCtx)
        yield* this.textRenderer.Render({
            text: entity.text,
            size: entity.textHeight,
            position: entity.startPoint,
            color, layer
        })
    }

    /**
     * Updates batches directly.
     * @param entity
     * @param blockCtx {?BlockContext} Nested block insert when non-null.
     */
    _ProcessInsert(entity, blockCtx = null) {
        if (blockCtx) {
            if (blockCtx.name === entity.name) {
                console.warn("Recursive block reference: " + blockCtx.name)
                return
            }
            /* Flatten nested blocks definition. */
            const block = this.blocks.get(entity.name)
            if (!block) {
                console.warn("Unresolved nested block reference: " + entity.name)
            }
            const nestedCtx = blockCtx.NestedBlockContext(block, entity)
            for (const entity of block.data.entities) {
                this._ProcessDxfEntity(entity, nestedCtx)
            }
            return
        }

        const block = this.blocks.get(entity.name)
        if (block === null) {
            console.warn("Unresolved block reference in INSERT: " + entity.name)
            return
        }
        if (!block.HasGeometry()) {
            return
        }
        const layer = this._GetEntityLayer(entity, null)
        const color = this._GetEntityColor(entity, null)
        const lineType = this._GetLineType(entity, null, null)
        const key = new BatchingKey(layer, entity.name, BatchingKey.GeometryType.BLOCK_INSTANCE,
                                    color, lineType)
        const batch = this._GetBatch(key)
        const transform = block.InstantiationContext().GetInsertionTransform(entity)
        /* Update bounding box and origin with transformed block origin. */
        this._UpdateBounds(new Vector2().applyMatrix3(transform))
        transform.translate(-this.origin.x, -this.origin.y)
        //XXX grid instancing not supported yet
        batch.PushInstanceTransform(transform)
    }

    /**
     * Generate entities for shaped polyline (e.g. line resulting in mesh). All segments are shaped
     * (have start/end width). Segments may be bulge.
     * @param vertices
     * @param layer
     * @param color
     * @param lineType
     * @param shape {Boolean} True if closed polyline.
     * @return {Generator<Entity>}
     */
    *_GenerateShapedPolyline(vertices, layer, color, lineType, shape) {
        //XXX
        yield new Entity({
                             type: Entity.Type.POLYLINE,
                             vertices,
                             layer,
                             color,
                             lineType,
                             shape
                         })
    }

    *_DecomposePolyline(entity, blockCtx = null) {
        const verticesCount = entity.vertices.length
        if (verticesCount < 2) {
            return
        }
        const color = this._GetEntityColor(entity, blockCtx)
        const layer = this._GetEntityLayer(entity, blockCtx)
        const _this = this
        let startIdx = 0
        let curPlainLine = this._IsPlainLine(entity.vertices[0])
        let curLineType = this._GetLineType(entity, entity.vertices[0], blockCtx)
        let curVertices = null

        function *CommitSegment(endIdx) {
            if (endIdx === startIdx) {
                return
            }
            let isClosed = false
            let vertices = curVertices
            if (endIdx === verticesCount && startIdx === 0) {
                isClosed = true
                if (vertices === null) {
                    vertices = entity.vertices
                }
            } else if (endIdx === verticesCount - 1 && startIdx === 0) {
                if (vertices === null) {
                    vertices = entity.vertices
                }
            } else if (endIdx === verticesCount) {
                if (vertices === null) {
                    vertices = entity.vertices.slice(startIdx, endIdx)
                    vertices.push(entity.vertices[0])
                }
            } else {
                if (vertices === null) {
                    vertices = entity.vertices.slice(startIdx, endIdx + 1)
                }
            }

            if (curPlainLine) {
                yield new Entity({
                                     type: Entity.Type.POLYLINE,
                                     vertices, layer, color,
                                     lineType: curLineType,
                                     shape: isClosed
                                 })
            } else {
                yield* _this._GenerateShapedPolyline(vertices, layer, color, curLineType, isClosed)
            }

            startIdx = endIdx
            if (endIdx !== verticesCount) {
                curPlainLine = _this._IsPlainLine(entity.vertices[endIdx])
                curLineType = _this._GetLineType(entity, entity.vertices[endIdx])
            }
            curVertices = null
        }

        for (let vIdx = 1; vIdx <= verticesCount; vIdx++) {
            const prevVtx = entity.vertices[vIdx - 1]
            let vtx
            if (vIdx === verticesCount) {
                if (!entity.shape) {
                    yield* CommitSegment(vIdx - 1)
                    break
                }
                vtx = entity.vertices[0]
            } else {
                vtx = entity.vertices[vIdx]
            }

            if (Boolean(prevVtx.bulge) && curPlainLine) {
                if (curVertices === null) {
                    curVertices = entity.vertices.slice(startIdx, vIdx)
                }
                this._GenerateBulgeVertices(curVertices, prevVtx, vtx, prevVtx.bulge)
            } else if (curVertices !== null) {
                curVertices.push(vtx)
            }

            if (vIdx === verticesCount) {
                yield* CommitSegment(vIdx)
                break
            }

            const isPlainLine = this._IsPlainLine(vtx)
            const lineType = this._GetLineType(entity, vtx)
            if (isPlainLine !== curPlainLine ||
                /* Line type is accounted for plain lines only. */
                (curPlainLine && lineType !== curLineType)) {

                yield* CommitSegment(vIdx)
            }
        }
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessPoints(entity, blockCtx = null) {
        const key = new BatchingKey(entity.layer, blockCtx?.name,
                                    BatchingKey.GeometryType.POINTS, entity.color, 0)
        const batch = this._GetBatch(key)
        for (const v of entity.vertices) {
            batch.PushVertex(this._TransformVertex(v, blockCtx))
        }
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessLineSegments(entity, blockCtx = null) {
        if (entity.vertices.length % 2 !== 0) {
            throw Error("Even number of vertices expected")
        }
        const key = new BatchingKey(entity.layer, blockCtx?.name,
                                    BatchingKey.GeometryType.LINES, entity.color, entity.lineType)
        const batch = this._GetBatch(key)
        for (const v of entity.vertices) {
            batch.PushVertex(this._TransformVertex(v, blockCtx))
        }
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessPolyline(entity, blockCtx = null) {
        if (entity.vertices.length < 2) {
            return
        }
        /* It is more optimal to render short polylines un-indexed. Also DXF often contains
         * polylines with just two points.
         */
        const verticesCount = entity.vertices.length
        if (verticesCount <= 3) {
            const key = new BatchingKey(entity.layer, blockCtx?.name,
                                        BatchingKey.GeometryType.LINES, entity.color,
                                        entity.lineType)
            const batch = this._GetBatch(key)
            let prev = null
            for (const v of entity.vertices) {
                if (prev !== null) {
                    batch.PushVertex(this._TransformVertex(prev, blockCtx))
                    batch.PushVertex(this._TransformVertex(v, blockCtx))
                }
                prev = v
            }
            if (entity.shape && verticesCount > 2) {
                batch.PushVertex(this._TransformVertex(entity.vertices[verticesCount - 1], blockCtx))
                batch.PushVertex(this._TransformVertex(entity.vertices[0], blockCtx))
            }
            return
        }

        const key = new BatchingKey(entity.layer, blockCtx?.name,
                                    BatchingKey.GeometryType.INDEXED_LINES,
                                    entity.color, entity.lineType)
        const batch = this._GetBatch(key)
        /* Line may be split if exceeds chunk limit. */
        for (const lineChunk of entity._IterateLineChunks()) {
            const chunk = batch.PushChunk(lineChunk.verticesCount)
            for (const v of lineChunk.vertices) {
                chunk.PushVertex(this._TransformVertex(v, blockCtx))
            }
            for (const idx of lineChunk.indices) {
                chunk.PushIndex(idx)
            }
            chunk.Finish()
        }
    }

    /**
     * @param entity {Entity}
     * @param blockCtx {?BlockContext}
     */
    _ProcessTriangles(entity, blockCtx = null) {
        if (entity.vertices.length < 3) {
            return
        }
        if (entity.indices.length % 3 !== 0) {
            console.error("Unexpected size of indices array: " + entity.indices.length)
            return
        }
        const key = new BatchingKey(entity.layer, blockCtx?.name,
                                    BatchingKey.GeometryType.INDEXED_TRIANGLES,
                                    entity.color, 0)
        const batch = this._GetBatch(key)
        //XXX splitting into chunks is not yet implemented. Currently used only for text glyphs so
        // should fit into one chunk
        const chunk = batch.PushChunk(entity.vertices.length)
        for (const v of entity.vertices) {
            chunk.PushVertex(this._TransformVertex(v, blockCtx))
        }
        for (const idx of entity.indices) {
            chunk.PushIndex(idx)
        }
        chunk.Finish()
    }

    /** Resolve entity color.
     *
     * @param entity
     * @param blockCtx {?BlockContext}
     * @return {number} RGB color value. For block entity it also may be one of ColorCode values
     *  which are resolved on block instantiation.
     */
    _GetEntityColor(entity, blockCtx = null) {
        let color = ColorCode.BY_LAYER
        if (entity.colorIndex === 0) {
            color = ColorCode.BY_BLOCK
        } else if (entity.colorIndex === 256) {
            color = ColorCode.BY_LAYER
        } else if (entity.hasOwnProperty("color")) {
            color = entity.color
        }

        if (blockCtx) {
            return color
        }
        if (color === ColorCode.BY_LAYER || color === ColorCode.BY_BLOCK) {
            /* BY_BLOCK is not useful when not in block so replace it by layer as well. */
            if (entity.hasOwnProperty("layer")) {
                const layer = this.layers.get(entity.layer)
                if (layer) {
                    return layer.color
                }
            }
        } else {
            return color
        }
        /* Fallback to black. */
        return 0
    }

    /** @return {?string} Layer name, null for block entity. */
    _GetEntityLayer(entity, blockCtx = null) {
        if (blockCtx) {
            return null
        }
        if (entity.hasOwnProperty("layer")) {
            return entity.layer
        }
        return "0"
    }

    _GetBatch(key) {
        let batch = this.batches.find({key})
        if (batch !== null) {
            return batch
        }
        batch = new RenderBatch(key)
        this.batches.insert(batch)
        if (key.blockName !== null &&
            key.geometryType !== BatchingKey.GeometryType.BLOCK_INSTANCE &&
            key.geometryType !== BatchingKey.GeometryType.POINT_INSTANCE) {

            /* Block definition batch. */
            const block = this.blocks.get(key.blockName)
            if (block) {
                block.batches.push(batch)
            }
        }
        return batch
    }

    /**
     * Apply all necessary final transforms to a vertex before just before storing it in a rendering
     * batch.
     * @param v {{x: number, y: number}}
     * @param blockCtx {BlockContext}
     * @return {{x: number, y: number}}
     */
    _TransformVertex(v, blockCtx = null) {
        if (blockCtx) {
            /* Block definition in block coordinates. So it should not touch bounds and origin. */
            return blockCtx.TransformVertex(v)
        }
        this._UpdateBounds(v)
        return { x: v.x - this.origin.x, y: v.y - this.origin.y }
    }

    /** @param v {{x,y}} Vertex to extend bounding box with and set origin. */
    _UpdateBounds(v) {
        // if (v.x < 200000 || v.x > 210000) {
        //     console.log(v)//XXX
        // }
        if (this.bounds === null) {
            this.bounds = { minX: v.x, maxX: v.x, minY: v.y, maxY: v.y }
        } else {
            if (v.x < this.bounds.minX) {
                this.bounds.minX = v.x
            } else if (v.x > this.bounds.maxX) {
                this.bounds.maxX = v.x
            }
            if (v.y < this.bounds.minY) {
                this.bounds.minY = v.y
            } else if (v.y > this.bounds.maxY) {
                this.bounds.maxY = v.y
            }
        }
        if (this.origin === null) {
            this.origin = { x: v.x, y: v.y }
        }
    }

    _BuildScene() {
        let verticesSize = 0
        let indicesSize = 0
        let transformsSize = 0
        this.batches.each(b => {
            verticesSize += b.GetVerticesBufferSize()
            indicesSize += b.GetIndicesBufferSize()
            transformsSize += b.GetTransformsSize()
        })

        const scene = {
            vertices: new ArrayBuffer(verticesSize),
            indices: new ArrayBuffer(indicesSize),
            transforms: new ArrayBuffer(transformsSize),
            batches: [],
            layers: [],
            origin: this.origin,
            bounds: this.bounds
        }

        const buffers = {
            vertices: new Float32Array(scene.vertices),
            verticesOffset: 0,
            indices: new Uint16Array(scene.indices),
            indicesOffset: 0,
            transforms: new Float32Array(scene.transforms),
            transformsOffset: 0
        }

        this.batches.each(b => {
            scene.batches.push(b.Serialize(buffers))
        })

        for (const layer of this.layers.values()) {
            scene.layers.push({
                name: layer.name,
                color: layer.color
            })
        }

        scene.pointShapeHasDot = (this.pdMode & PdMode.MARK_MASK) === PdMode.DOT

        return scene
    }
}

class RenderBatch {
    constructor(key) {
        this.key = key
        if (key.IsIndexed()) {
            this.chunks = []
        } else if (key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            this.transforms = new DynamicBuffer(NativeType.FLOAT32)
        } else {
            this.vertices = new DynamicBuffer(NativeType.FLOAT32)
        }
    }

    PushVertex(v) {
        const idx = this.vertices.Push(v.x)
        this.vertices.Push(v.y)
        return idx
    }

    /**
     * @param matrix {Matrix3} 3x3 Transform matrix. Assuming 2D affine transform so only top 3x2
     *  sub-matrix is taken.
     */
    PushInstanceTransform(matrix) {
        /* Storing in row-major order as expected by renderer. */
        for (let row = 0; row < 2; row++) {
            for (let col = 0; col < 3; col++) {
                this.transforms.Push(matrix.elements[col * 3 + row])
            }
        }
    }

    /** This method actually reserves space for the specified number of indexed vertices in some
     * chunk. The returned object should be used to push exactly the same amount vertices and any
     * number of their referring indices.
     * @param verticesCount Number of vertices in the chunk.
     * @return {IndexedChunkWriter}
     */
    PushChunk(verticesCount) {
        if (verticesCount > INDEXED_CHUNK_SIZE) {
            throw new Error("Vertices count exceeds chunk limit: " + verticesCount)
        }
        /* Find suitable chunk with minimal remaining space to fill them as fully as possible. */
        let curChunk = null
        let curSpace = 0
        for (const chunk of this.chunks) {
            const space = INDEXED_CHUNK_SIZE - chunk.vertices.GetSize() / 2
            if (space < verticesCount) {
                continue
            }
            if (curChunk === null || space < curSpace) {
                curChunk = chunk
                curSpace = space
            }
        }
        if (curChunk === null) {
            curChunk = this._NewChunk(verticesCount)
        }
        return new IndexedChunkWriter(curChunk, verticesCount)
    }

    /** @return Vertices buffer required size in bytes. */
    GetVerticesBufferSize() {
        if (this.key.IsIndexed()) {
            let size = 0
            for (const chunk of this.chunks) {
                size += chunk.vertices.GetSize()
            }
            return size * Float32Array.BYTES_PER_ELEMENT
        } else if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            return 0
        } else {
            return this.vertices.GetSize() * Float32Array.BYTES_PER_ELEMENT
        }
    }

    /** @return Indices buffer required size in bytes. */
    GetIndicesBufferSize() {
        if (this.key.IsIndexed()) {
            let size = 0
            for (const chunk of this.chunks) {
                size += chunk.indices.GetSize()
            }
            return size * Uint16Array.BYTES_PER_ELEMENT
        } else {
            return 0
        }
    }

    /** @return Instances transforms buffer required size in bytes. */
    GetTransformsSize() {
        if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            return this.transforms.GetSize() * Float32Array.BYTES_PER_ELEMENT
        } else {
            return 0
        }
    }

    Serialize(buffers) {
        if (this.key.IsIndexed()) {
            const batch = {
                key: this.key,
                chunks: []
            }
            for (const chunk of this.chunks) {
                batch.chunks.push(chunk.Serialize(buffers))
            }
            return batch

        } else if (this.key.geometryType === BatchingKey.GeometryType.BLOCK_INSTANCE) {
            const size = this.transforms.GetSize()
            const batch = {
                key: this.key,
                transformsOffset: buffers.transformsOffset,
                transformsSize: size
            }
            this.transforms.CopyTo(buffers.transforms, buffers.transformsOffset)
            buffers.transformsOffset += size
            return batch

        } else {
            const size = this.vertices.GetSize()
            const batch = {
                key: this.key,
                verticesOffset: buffers.verticesOffset,
                verticesSize: size
            }
            this.vertices.CopyTo(buffers.vertices, buffers.verticesOffset)
            buffers.verticesOffset += size
            return batch
        }
    }

    _NewChunk(initialCapacity) {
        const chunk = new IndexedChunk(initialCapacity)
        this.chunks.push(chunk)
        return chunk
    }
}

class Block {
    /** @param data {{}} Raw DXF entity. */
    constructor(data) {
        this.data = data
        /* Number of times referenced from top-level entities (INSERT). */
        this.useCount = 0
        /* Number of times referenced by other block. */
        this.nestedUseCount = 0
        /* Offset {x, y} to apply for all vertices. Used to move origin near vertices location to
         * minimize precision loss.
         */
        this.offset = null
        /* Definition batches. Used for root blocks flattening. */
        this.batches = []
    }

    /** @return {Boolean} True if has something to draw. */
    HasGeometry() {
        /* Offset is set on first geometry vertex encountered. */
        return this.offset !== null
    }

    RegisterInsert(entity) {
        this.useCount++
    }

    RegisterNestedUse(usedByBlock) {
        this.nestedUseCount++
    }

    /** @return {BlockContext} Context for block definition. */
    DefinitionContext() {
        return new BlockContext(this, BlockContext.Type.DEFINITION)
    }

    //XXX
    InstantiationContext() {
        //XXX
        return new BlockContext(this, BlockContext.Type.INSTANTIATION)
    }
}

//XXX flattening context, block/layer color, layer name, insert transform
class BlockContext {
    constructor(block, type) {
        this.block = block
        this.type = type
        this.origin = this.block.data.position
        /* Transform to apply for block definition entities not including block offset. */
        this.transform = new Matrix3()
    }

    /** @return {string} Block name */
    get name() {
        return this.block.data.name
    }

    /**
     * @param v {{x,y}}
     * @return {{x,y}}
     */
    TransformVertex(v) {
        const result = new Vector2(v.x, v.y).applyMatrix3(this.transform)
        if (this.block.offset === null) {
            this.block.offset = result
            return new Vector2()
        }
        result.sub(this.block.offset)
        return result
    }

    /**
     * Get transform for block instance.
     * @param entity Raw DXF INSERT entity.
     * @return {Matrix3} Transform matrix for block instance to apply to the block definition.
     */
    GetInsertionTransform(entity) {
        const mInsert = new Matrix3().translate(-this.origin.x, -this.origin.y)
        mInsert.scale(entity.xScale || 1, entity.yScale || 1)
        mInsert.rotate(-(entity.rotation || 0) * Math.PI / 180)
        mInsert.translate(entity.position.x, entity.position.y)
        if (this.type !== BlockContext.Type.INSTANTIATION) {
            return mInsert
        }
        const mOffset = new Matrix3().translate(this.block.offset.x, this.block.offset.y)
        return mInsert.multiply(mOffset)
    }

    /**
     * Create context for nested block.
     * @param block {Block} Nested block.
     * @param entity Raw DXF INSERT entity.
     * @return {BlockContext} Context to use for nested block entities.
     */
    NestedBlockContext(block, entity) {
        block.RegisterNestedUse(this.block)
        const nestedCtx = new BlockContext(block, BlockContext.Type.NESTED_DEFINITION)
        const nestedTransform = nestedCtx.GetInsertionTransform(entity)
        const ctx = new BlockContext(this.block, BlockContext.Type.NESTED_DEFINITION)
        ctx.transform = new Matrix3().multiplyMatrices(this.transform, nestedTransform)
        return ctx
    }
}

BlockContext.Type = Object.freeze({
    DEFINITION: 0,
    NESTED_DEFINITION: 1,
    INSTANTIATION: 2
})

class IndexedChunk {
    constructor(initialCapacity) {
        if (initialCapacity < 16) {
            initialCapacity = 16
        }
        /* Average two indices per vertex. */
        this.indices = new DynamicBuffer(NativeType.UINT16, initialCapacity * 2)
        /* Two components per vertex. */
        this.vertices = new DynamicBuffer(NativeType.FLOAT32, initialCapacity * 2)
    }

    Serialize(buffers) {
        const chunk = {}
        {
            const size = this.vertices.GetSize()
            chunk.verticesOffset = buffers.verticesOffset
            chunk.verticesSize = size
            this.vertices.CopyTo(buffers.vertices, buffers.verticesOffset)
            buffers.verticesOffset += size
        }
        {
            const size = this.indices.GetSize()
            chunk.indicesOffset = buffers.indicesOffset
            chunk.indicesSize = size
            this.indices.CopyTo(buffers.indices, buffers.indicesOffset)
            buffers.indicesOffset += size
        }
        return chunk
    }
}

class IndexedChunkWriter {
    constructor(chunk, verticesCount) {
        this.chunk = chunk
        this.verticesCount = verticesCount
        this.verticesOffset = this.chunk.vertices.GetSize() / 2
        this.numVerticesPushed = 0
    }

    PushVertex(v) {
        if (this.numVerticesPushed === this.verticesCount) {
            throw new Error()
        }
        this.chunk.vertices.Push(v.x)
        this.chunk.vertices.Push(v.y)
        this.numVerticesPushed++
    }

    PushIndex(idx) {
        if (idx < 0 || idx >= this.verticesCount) {
            throw new Error(`Index out of range: ${idx}/${this.verticesCount}`)
        }
        this.chunk.indices.Push(idx + this.verticesOffset)
    }

    Finish() {
        if (this.numVerticesPushed !== this.verticesCount) {
            throw new Error(`Not all vertices pushed: ${this.numVerticesPushed}/${this.verticesCount}`)
        }
    }
}

/** Internal entity representation. DXF features are decomposed into these simpler entities. Whole
 * entity always shares single material.
 */
export class Entity {
    /** @param type {Entity.Type}
     * @param vertices {{x, y}[]}
     * @param indices {?number[]} Indices for indexed geometry.
     * @param layer {?string}
     * @param color {number}
     * @param lineType {?number}
     * @param shape {Boolean} true if closed shape.
     */
    constructor({type, vertices, indices = null, layer = null, color, lineType = 0, shape = false}) {
        this.type = type
        this.vertices = vertices
        this.indices = indices
        this.layer = layer
        this.color = color
        this.lineType = lineType
        this.shape = shape
    }

    *_IterateVertices(startIndex, count) {
        for (let idx = startIndex; idx < startIndex + count; idx++) {
            yield this.vertices[idx]
        }
    }

    /** Split line into chunks with at most INDEXED_CHUNK_SIZE vertices in each one. Each chunk is
     * an object with the following properties:
     *  * "verticesCount" - length of "vertices"
     *  * "vertices" - iterator for included vertices.
     *  * "indices" - iterator for indices.
     *  Closed shapes are handled properly.
     */
    *_IterateLineChunks() {
        const verticesCount = this.vertices.length
        if (verticesCount < 2) {
            return
        }
        const _this = this
        /* chunkOffset == verticesCount for shape closing vertex. */
        for (let chunkOffset = 0; chunkOffset <= verticesCount; chunkOffset += INDEXED_CHUNK_SIZE) {
            let count = verticesCount - chunkOffset
            let isLast
            if (count > INDEXED_CHUNK_SIZE) {
                count = INDEXED_CHUNK_SIZE
                isLast = false
            } else {
                isLast = true
            }
            if (isLast && this.shape && chunkOffset > 0 && count === INDEXED_CHUNK_SIZE) {
                /* Corner case - required shape closing vertex does not fit into the chunk. Will
                * require additional chunk.
                */
                isLast = false
            }
            if (chunkOffset === verticesCount && !this.shape) {
                /* Shape is not closed and it is last closing vertex iteration. */
                break
            }

            let vertices, indices, chunkVerticesCount
            if (count < 2) {
                /* Either last vertex or last shape-closing vertex, or both. */
                if (count === 1 && this.shape) {
                    /* Both. */
                    vertices = (function*() {
                        yield this.vertices[chunkOffset]
                        yield this.vertices[0]
                    })()
                } else if (count === 1) {
                    /* Just last vertex. Take previous one to make a line. */
                    vertices = (function*() {
                        yield this.vertices[chunkOffset - 1]
                        yield this.vertices[chunkOffset]
                    })()
                } else {
                    /* Just shape-closing vertex. Take last one to make a line. */
                    vertices = (function*() {
                        yield this.vertices[verticesCount - 1]
                        yield this.vertices[0]
                    })()
                }
                indices = _IterateLineIndices(2, false)
                chunkVerticesCount = 2
            } else if (isLast && this.shape && chunkOffset > 0 && count < INDEXED_CHUNK_SIZE) {
                /* Additional vertex to close the shape. */
                vertices = (function*() {
                    yield* _this._IterateVertices(chunkOffset, count)
                    yield this.vertices[0]
                })()
                indices = _IterateLineIndices(count + 1, false)
                chunkVerticesCount = count + 1
            } else {
                vertices = this._IterateVertices(chunkOffset, count)
                indices = _IterateLineIndices(count,
                                              isLast && chunkOffset === 0 && this.shape)
                chunkVerticesCount = count
            }
            yield {
                verticesCount: chunkVerticesCount,
                vertices,
                indices
            }
        }
    }
}

Entity.Type = Object.freeze({
    POINTS: 0,
    /** Each vertices pair defines a segment. */
    LINE_SEGMENTS: 1,
    POLYLINE: 2,
    TRIANGLES: 3
})

function* _IterateLineIndices(verticesCount, close) {
    for (let idx = 0; idx < verticesCount - 1; idx++) {
        yield idx
        yield idx + 1
    }
    if (close && verticesCount > 2) {
        yield verticesCount - 1
        yield 0
    }
}

/** Point display mode, $PDMODE system variable. */
const PdMode = Object.freeze({
    DOT: 0,
    NONE: 1,
    PLUS: 2,
    CROSS: 3,
    TICK: 4,
    MARK_MASK: 0xf,

    CIRCLE: 0x20,
    SQUARE: 0x40,

    SHAPE_MASK: 0xf0
})

/** Special color values, used for block entities. Regular entities color is resolved instantly. */
export const ColorCode = Object.freeze({
    BY_LAYER: -1,
    BY_BLOCK: -2
})

DxfScene.DefaultOptions = {
    /** Target angle for each segment of tessellated arc. */
    arcTessellationAngle: 10 / 180 * Math.PI,
    /** Text rendering options. */
    textOptions: TextRenderer.DefaultOptions
}
