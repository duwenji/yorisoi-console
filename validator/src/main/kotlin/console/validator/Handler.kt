package console.validator

import com.amazonaws.services.lambda.runtime.Context
import com.amazonaws.services.lambda.runtime.RequestHandler
import com.amazonaws.services.lambda.runtime.events.S3Event
import io.github.duwenji.yorisoi.core.format.material.Grants
import io.github.duwenji.yorisoi.core.format.ListedCollection
import io.github.duwenji.yorisoi.core.format.PackageRef
import io.github.duwenji.yorisoi.core.format.PublisherChange
import software.amazon.awssdk.core.sync.RequestBody
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.Put
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException
import software.amazon.awssdk.services.dynamodb.model.Update
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.CopyObjectRequest
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import software.amazon.awssdk.services.s3.model.PutObjectRequest
import java.net.URLDecoder
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * The machine-review Lambda (ADR-001 A-11, DES-007): S3 calls it for each file under `intake/`
 * (channels) and `intake-col/` (collections, DM-001).
 *
 * A channel's package and icon both raise events, possibly at once: when both are there it reviews
 * them, resolving the collections it uses against those listed now (DES-007 J-2), and moves the
 * submission on: to `awaiting_review` (with the review samples' prompts stored for the operator and
 * what approval copies, J-10), or to `validation_failed` (freeing the channel, the files moved to
 * `archive/`). A collection has only its package; its outside resources are read to check their
 * hashes (J-5), and the channels that use it are checked against it (D-8, J-7).
 *
 * The write is conditional on `uploading`, so only one run records an outcome.
 */
class Handler(
    private val s3: S3Client = S3Client.builder().httpClient(UrlConnectionHttpClient.create()).build(),
    private val db: DynamoDbClient = DynamoDbClient.builder().httpClient(UrlConnectionHttpClient.create()).build(),
    private val table: String = env("TABLE_NAME"),
    private val intakeBucket: String = env("INTAKE_BUCKET"),
    private val recordsBucket: String = env("RECORDS_BUCKET"),
    private val publicBucket: String = env("PUBLIC_BUCKET"),
    private val fetcher: ExternalFetcher = HttpsFetcher(),
    private val clock: () -> Instant = Instant::now,
) : RequestHandler<S3Event, String> {

    override fun handleRequest(event: S3Event, context: Context?): String {
        val results = event.records.map { record ->
            val key = URLDecoder.decode(record.s3.`object`.key, Charsets.UTF_8)
            runCatching { process(key) }.getOrElse { e ->
                context?.logger?.log("failed on $key: ${e.stackTraceToString()}")
                throw e
            }
        }
        return results.joinToString("; ")
    }

    fun process(key: String): String {
        KEY.matchEntire(key)?.let { val (channelId, submissionId) = it.destructured; return processChannel(channelId, submissionId) }
        COLLECTION_KEY.matchEntire(key)?.let { val (collectionId, submissionId) = it.destructured; return processCollection(collectionId, submissionId) }
        return "skip $key"
    }

    // ---- channels ----

    private fun processChannel(channelId: String, submissionId: String): String {
        val sub = getItem("CH#$channelId", "SUB#$submissionId") ?: return "no submission for $channelId/$submissionId"
        if (sub.str("state") != "uploading") return "already ${sub.str("state")}: $submissionId"
        val zipKey = sub.str("intakeKey") ?: return "no intake key"
        val iconKey = sub.str("iconIntakeKey") ?: return "no icon key"
        // The other file's event will do the work if it isn't here yet.
        val zip = read(zipKey) ?: return "waiting for $zipKey"
        val icon = read(iconKey) ?: return "waiting for $iconKey"

        val channel = getItem("CH#$channelId", "CH")
        val latest = channel?.get("latestApproved")?.m()?.get("version")?.n()?.toInt()
        val accountId = sub.str("accountId").orEmpty()
        val former = channel?.str("publisherId")?.let(::accountIdsOf)?.minus(accountId).orEmpty()
        val upload = Upload(channelId, submissionId, accountId, latest, former)
        val outcome = MachineReview.review(upload, zip, icon, DynamoCatalog())
        val now = iso(clock())
        return try {
            when (outcome) {
                is Outcome.Passed -> channelPassed(upload, outcome, now)
                is Outcome.Failed -> channelFailed(upload, outcome, now, zipKey, iconKey)
            }
        } catch (e: TransactionCanceledException) {
            "someone else recorded $submissionId"
        }
    }

    private fun channelPassed(upload: Upload, outcome: Outcome.Passed, now: String): String {
        val samplesKey = "samples/${upload.submissionId}/prompts.json"
        s3.putObject(
            PutObjectRequest.builder().bucket(recordsBucket).key(samplesKey).contentType("application/json").build(),
            RequestBody.fromString(outcome.samplePrompts),
        )
        val l = outcome.listing
        val listing = mapOf(
            "appStage" to l.appStage,
            "collections" to l.collections.map { (alias, id, min) -> mapOf("as" to alias, "id" to id, "minVersion" to min) },
            "ownPrefetchBytes" to l.ownPrefetchBytes,
            "ownMedia" to l.ownMedia,
            "uses" to l.uses,
            "activities" to l.activities,
            "genres" to l.genres,
            "requires" to l.requires,
        )
        transact(
            update(
                "CH#${upload.channelId}", "SUB#${upload.submissionId}",
                "SET #s = :awaiting, version = :v, sha256 = :sha, #size = :size, iconSha256 = :icon, validation = :val, listing = :listing, " +
                    "samplesKey = :samples, submittedAt = :now, updatedAt = :now, rev = rev + :one, GSI2PK = :queue, GSI2SK = :order REMOVE #ttl",
                "#s = :uploading",
                mapOf("#s" to "state", "#size" to "size", "#ttl" to "ttl"),
                mapOf(
                    ":awaiting" to s("awaiting_review"), ":uploading" to s("uploading"), ":v" to n(outcome.version),
                    ":sha" to s(outcome.sha256), ":size" to n(outcome.size), ":icon" to s(outcome.iconSha256),
                    ":val" to validation(true, emptyList(), now, l.appStage, mapOf("collections" to collectionResults(outcome.collections))),
                    ":listing" to av(listing), ":samples" to s(samplesKey), ":now" to s(now), ":one" to n(1),
                    ":queue" to s("QUEUE#REVIEW"), ":order" to s("$now#${upload.channelId}"),
                ),
            ),
            audit(now, "CH#${upload.channelId}", upload.submissionId, ok = true),
        )
        return "passed ${upload.submissionId}"
    }

    private fun channelFailed(upload: Upload, outcome: Outcome.Failed, now: String, zipKey: String, iconKey: String): String {
        val extra = mapOf("collections" to collectionResults(outcome.collections))
        transact(
            update(
                "CH#${upload.channelId}", "SUB#${upload.submissionId}",
                "SET #s = :failed, validation = :val, decidedAt = :now, updatedAt = :now, rev = rev + :one" +
                    (if (outcome.version != null) ", version = :v" else "") + " REMOVE #ttl",
                "#s = :uploading",
                mapOf("#s" to "state", "#ttl" to "ttl"),
                buildMap {
                    put(":failed", s("validation_failed")); put(":uploading", s("uploading"))
                    put(":val", validation(false, outcome.findings, now, null, extra)); put(":now", s(now)); put(":one", n(1))
                    outcome.version?.let { put(":v", n(it)) }
                },
            ),
            // The channel is free for the next submission.
            free("CH#${upload.channelId}", "CH", upload.submissionId, now),
            audit(now, "CH#${upload.channelId}", upload.submissionId, ok = false, codes = outcome.findings.map { it.code }.distinct()),
        )
        for (key in listOf(zipKey, iconKey)) archive(key)
        return "failed ${upload.submissionId}: ${outcome.findings.joinToString { it.code }}"
    }

    private fun collectionResults(results: List<CollectionResult>): AttributeValue = av(
        results.map { r ->
            buildMap<String, Any?> {
                put("as", r.alias); put("collectionId", r.collectionId); put("status", if (r.usable) "usable" else "unusable")
                r.code?.let { put("code", it) }
                r.detail?.let { put("detail", it.take(500)) }
            }
        },
    )

    // ---- collections (DM-001) ----

    private fun processCollection(collectionId: String, submissionId: String): String {
        val sub = getItem("COL#$collectionId", "SUB#$submissionId") ?: return "no submission for $collectionId/$submissionId"
        if (sub.str("state") != "uploading") return "already ${sub.str("state")}: $submissionId"
        val zipKey = sub.str("intakeKey") ?: return "no intake key"
        val zip = read(zipKey) ?: return "waiting for $zipKey"

        val collection = getItem("COL#$collectionId", "COL")
        val latest = collection?.get("latestApproved")?.m()?.get("version")?.n()?.toInt()
        val usedBy = query("COL#$collectionId", "USEDBY#").map { item ->
            UsedBy(
                channelId = item.str("channelId").orEmpty(),
                publisherIds = item.str("publisherId")?.let(::accountIdsOf).orEmpty(),
                resources = item["resources"]?.m().orEmpty().mapValues { it.value.s().orEmpty() },
            )
        }
        val upload = CollectionUpload(collectionId, submissionId, sub.str("accountId").orEmpty(), latest, usedBy)
        val outcome = MachineReview.reviewCollection(upload, zip, fetcher)
        val now = iso(clock())
        return try {
            when (outcome) {
                is CollectionOutcome.Passed -> collectionPassed(upload, outcome, now)
                is CollectionOutcome.Failed -> collectionFailed(upload, outcome, now, zipKey)
            }
        } catch (e: TransactionCanceledException) {
            "someone else recorded $submissionId"
        }
    }

    private fun collectionPassed(upload: CollectionUpload, outcome: CollectionOutcome.Passed, now: String): String {
        val l = outcome.listing
        val listing = mapOf(
            "appStage" to l.appStage, "name" to l.name, "summary" to l.summary, "media" to l.media, "resourcesSize" to l.resourcesSize,
            "tags" to l.tags, "regions" to l.regions, "grants" to StoredGrants.write(l.grants), "resourceTypes" to l.resourceTypes,
            "externalResources" to l.externalResources.map { (id, url, size) -> mapOf("resourceId" to id, "url" to url, "size" to size) },
        )
        transact(
            update(
                "COL#${upload.collectionId}", "SUB#${upload.submissionId}",
                "SET #s = :awaiting, kind = :kind, version = :v, sha256 = :sha, #size = :size, validation = :val, listing = :listing, " +
                    "submittedAt = :now, updatedAt = :now, rev = rev + :one, GSI2PK = :queue, GSI2SK = :order REMOVE #ttl",
                "#s = :uploading",
                mapOf("#s" to "state", "#size" to "size", "#ttl" to "ttl"),
                mapOf(
                    ":awaiting" to s("awaiting_review"), ":uploading" to s("uploading"), ":kind" to s("collection"), ":v" to n(outcome.version),
                    ":sha" to s(outcome.sha256), ":size" to n(outcome.size),
                    ":val" to validation(true, emptyList(), now, l.appStage, collectionExtra(outcome.external, emptyList(), outcome.warnings)),
                    ":listing" to av(listing), ":now" to s(now), ":one" to n(1),
                    ":queue" to s("QUEUE#REVIEW"), ":order" to s("$now#col:${upload.collectionId}"),
                ),
            ),
            audit(now, "COL#${upload.collectionId}", upload.submissionId, ok = true),
        )
        return "passed ${upload.submissionId}"
    }

    private fun collectionFailed(upload: CollectionUpload, outcome: CollectionOutcome.Failed, now: String, zipKey: String): String {
        transact(
            update(
                "COL#${upload.collectionId}", "SUB#${upload.submissionId}",
                "SET #s = :failed, kind = :kind, validation = :val, decidedAt = :now, updatedAt = :now, rev = rev + :one" +
                    (if (outcome.version != null) ", version = :v" else "") + " REMOVE #ttl",
                "#s = :uploading",
                mapOf("#s" to "state", "#ttl" to "ttl"),
                buildMap {
                    put(":failed", s("validation_failed")); put(":uploading", s("uploading")); put(":kind", s("collection"))
                    put(":val", validation(false, outcome.findings, now, null, collectionExtra(outcome.external, outcome.inUse, outcome.warnings)))
                    put(":now", s(now)); put(":one", n(1))
                    outcome.version?.let { put(":v", n(it)) }
                },
            ),
            free("COL#${upload.collectionId}", "COL", upload.submissionId, now),
            audit(now, "COL#${upload.collectionId}", upload.submissionId, ok = false, codes = outcome.findings.map { it.code }.distinct()),
        )
        archive(zipKey)
        return "failed ${upload.submissionId}: ${outcome.findings.joinToString { it.code }}"
    }

    private fun collectionExtra(external: List<ExternalResult>, inUse: List<InUse>, warnings: List<Finding>): Map<String, AttributeValue> = mapOf(
        "external" to av(external.map { e -> buildMap<String, Any?> { put("resourceId", e.resourceId); put("ok", e.ok); e.detail?.let { put("detail", it.take(500)) } } }),
        "inUse" to av(inUse.map { mapOf("channelId" to it.channelId, "resourceId" to it.resourceId, "detail" to it.detail) }),
        "warnings" to av(warnings.map { mapOf("code" to it.code, "detail" to it.detail.take(500)) }),
    )

    /**
     * The collections listed now (DES-007 J-2): an `active` collection with an approved version,
     * on the list (`LISTED`), its package read from the public bucket (`col/{sha256}.zip`).
     */
    private inner class DynamoCatalog : Catalog {
        override fun listed(collectionId: String): ListedCollection? {
            val item = getItem("COL#$collectionId", "COL") ?: return null
            if (item.str("status") != "active" || item.str("GSI2PK") != "LISTED") return null
            val la = item["latestApproved"]?.m() ?: return null
            val pkg = la["package"]?.m() ?: return null
            val approvedAt = la.str("approvedAt")?.let(Instant::parse) ?: return null
            val change = item["producerChange"]?.m()
            return ListedCollection(
                id = collectionId,
                version = la.num("version").toInt(),
                producer = la.str("producer").orEmpty(),
                producerName = "",
                producerChange = change?.let { c -> c.str("from")?.let { from -> c.str("at")?.let { PublisherChange(from, Instant.parse(it), c.str("reason").orEmpty()) } } },
                name = la.str("name").orEmpty(),
                summary = la.str("summary").orEmpty(),
                media = la.strings("media"),
                resourcesSize = la.num("resourcesSize"),
                tags = la.strings("tags"),
                regions = la.strings("regions"),
                grants = StoredGrants.read(la["grants"]?.m()),
                pkg = PackageRef(pkg.str("url").orEmpty(), pkg.str("sha256").orEmpty(), pkg.num("size").toInt(), pkg.num("format").toInt()),
                approvedAt = approvedAt,
                minAppVersions = la.getValue("minAppVersions").m().mapValues { it.value.n().toInt() },
            )
        }

        override fun pkg(listed: ListedCollection): ByteArray? = try {
            s3.getObjectAsBytes(GetObjectRequest.builder().bucket(publicBucket).key("col/${listed.pkg.sha256}.zip").build()).asByteArray()
        } catch (e: NoSuchKeyException) {
            null
        }
    }

    /** Every account id the account has used: its key now and those moved from (DM-001 KEY). */
    private fun accountIdsOf(publisherId: String): Set<String> =
        query("PUB#$publisherId", "KEY#").mapNotNull { it.str("accountId") }.toSet()

    // ---- S3 ----

    private fun read(key: String): ByteArray? = try {
        s3.getObjectAsBytes(GetObjectRequest.builder().bucket(intakeBucket).key(key).build()).asByteArray()
    } catch (e: NoSuchKeyException) {
        null
    }

    /** DM-001 M-4: settled packages wait 90 days under archive/ (archive-col/ for collections). */
    private fun archive(key: String) {
        val target = if (key.startsWith("intake-col/")) key.replaceFirst("intake-col/", "archive-col/") else key.replaceFirst("intake/", "archive/")
        s3.copyObject(CopyObjectRequest.builder().sourceBucket(intakeBucket).sourceKey(key).destinationBucket(intakeBucket).destinationKey(target).build())
        s3.deleteObject(DeleteObjectRequest.builder().bucket(intakeBucket).key(key).build())
    }

    // ---- DynamoDB ----

    private fun getItem(pk: String, sk: String): Map<String, AttributeValue>? =
        db.getItem(GetItemRequest.builder().tableName(table).key(mapOf("PK" to s(pk), "SK" to s(sk))).consistentRead(true).build())
            .item().takeIf { it.isNotEmpty() }

    private fun query(pk: String, skPrefix: String): List<Map<String, AttributeValue>> {
        val items = mutableListOf<Map<String, AttributeValue>>()
        var start: Map<String, AttributeValue>? = null
        do {
            val page = db.query(
                QueryRequest.builder().tableName(table).consistentRead(true)
                    .keyConditionExpression("PK = :pk AND begins_with(SK, :sk)")
                    .expressionAttributeValues(mapOf(":pk" to s(pk), ":sk" to s(skPrefix)))
                    .apply { if (start != null) exclusiveStartKey(start) }
                    .build(),
            )
            items += page.items()
            start = page.lastEvaluatedKey().takeIf { it.isNotEmpty() }
        } while (start != null)
        return items
    }

    private fun update(pk: String, sk: String, expression: String, condition: String, names: Map<String, String>, values: Map<String, AttributeValue>) =
        TransactWriteItem.builder().update(
            Update.builder().tableName(table).key(mapOf("PK" to s(pk), "SK" to s(sk)))
                .updateExpression(expression).conditionExpression(condition)
                .apply { if (names.isNotEmpty()) expressionAttributeNames(names) }
                .expressionAttributeValues(values).build(),
        ).build()

    /** Frees the channel or collection for the next submission. */
    private fun free(pk: String, sk: String, submissionId: String, now: String) = update(
        pk, sk,
        "SET updatedAt = :now, rev = rev + :one REMOVE pendingSubmissionId",
        "pendingSubmissionId = :sid",
        emptyMap(),
        mapOf(":now" to s(now), ":one" to n(1), ":sid" to s(submissionId)),
    )

    private fun transact(vararg items: TransactWriteItem) {
        db.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(*items).build())
    }

    /** The audit entry, shaped as the console API writes them (api/src/console/deps.ts). */
    private fun audit(now: String, target: String, submissionId: String, ok: Boolean, codes: List<String> = emptyList()): TransactWriteItem {
        val eventId = ulid(clock())
        val detail = buildMap {
            put("submissionId", s(submissionId)); put("ok", AttributeValue.fromBool(ok))
            if (codes.isNotEmpty()) put("codes", AttributeValue.fromL(codes.map(::s)))
        }
        return TransactWriteItem.builder().put(
            Put.builder().tableName(table).item(
                mapOf(
                    "PK" to s("AUDIT#${now.substring(0, 7)}"), "SK" to s("$now#$eventId"), "GSI1PK" to s("TARGET#$target"), "GSI1SK" to s(now),
                    "type" to s("audit"), "eventId" to s(eventId), "at" to s(now), "actorSub" to s("machine-review"), "actorRole" to s("system"),
                    "action" to s("submission.validate"), "target" to s(target), "detail" to AttributeValue.fromM(detail),
                ),
            ).build(),
        ).build()
    }

    private fun validation(ok: Boolean, findings: List<Finding>, now: String, appStage: Int?, extra: Map<String, AttributeValue>): AttributeValue =
        AttributeValue.fromM(
            buildMap {
                put("ok", AttributeValue.fromBool(ok))
                put("errors", AttributeValue.fromL(findings.map { AttributeValue.fromM(mapOf("code" to s(it.code), "detail" to s(it.detail.take(500)))) }))
                appStage?.let { put("appStage", n(it)) }
                put("checkedAt", s(now))
                put("validatorVersion", s(MachineReview.VALIDATOR))
                putAll(extra)
            },
        )

    companion object {
        private val KEY = Regex("intake/([a-z0-9-]{3,40})/([0-9A-HJKMNP-TV-Z]{26})\\.(zip|png)")
        private val COLLECTION_KEY = Regex("intake-col/([a-z0-9-]{3,40})/([0-9A-HJKMNP-TV-Z]{26})\\.zip")
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
        private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        private val random = SecureRandom()

        private fun env(name: String) = System.getenv(name) ?: error("$name is not set")

        /** The same form as the console API: UTC, milliseconds, `Z` (DM-001 M-12). */
        fun iso(at: Instant): String = ISO.format(at)

        fun ulid(at: Instant): String {
            var t = at.toEpochMilli()
            val time = CharArray(10)
            for (i in 9 downTo 0) {
                time[i] = CROCKFORD[(t % 32).toInt()]
                t /= 32
            }
            return String(time) + (1..16).map { CROCKFORD[random.nextInt(32)] }.joinToString("")
        }

        /** Plain values (strings, numbers, booleans, maps, lists) as DynamoDB attributes. */
        fun av(value: Any?): AttributeValue = when (value) {
            null -> AttributeValue.fromNul(true)
            is AttributeValue -> value
            is String -> s(value)
            is Int, is Long -> AttributeValue.fromN(value.toString())
            is Boolean -> AttributeValue.fromBool(value)
            is Map<*, *> -> AttributeValue.fromM(value.entries.associate { (k, v) -> k.toString() to av(v) })
            is Collection<*> -> AttributeValue.fromL(value.map(::av))
            else -> error("can't store ${value::class}")
        }

        private fun s(value: String): AttributeValue = AttributeValue.fromS(value)
        private fun n(value: Int): AttributeValue = AttributeValue.fromN(value.toString())
        private fun Map<String, AttributeValue>.str(name: String): String? = this[name]?.s()
        private fun Map<String, AttributeValue>.num(name: String): Long = this[name]?.n()?.toLong() ?: 0L
        private fun Map<String, AttributeValue>.strings(name: String): List<String> = this[name]?.l().orEmpty().mapNotNull { it.s() }
    }
}

/**
 * A collection's grants as stored with its listing, and read back whole: a channel's review compares
 * them with the package's, so dropping `apps` or `grounding` would reject every channel using the
 * collection (API-CHANNEL-LIST P-15).
 */
internal object StoredGrants {
    /** As the list copies them: the app checks the copy against the package, `grounding` included. */
    fun write(g: Grants): Map<String, Any> =
        mapOf("publishers" to (g.publishers?.sorted() ?: "*")) + (g.apps?.let { mapOf("apps" to it.sorted()) } ?: emptyMap()) +
            (if (g.grounding) mapOf("grounding" to true) else emptyMap())

    fun read(m: Map<String, AttributeValue>?): Grants {
        if (m == null) return Grants(emptySet())
        val p = m["publishers"]
        val publishers = when {
            p == null -> emptySet()
            p.s() == "*" -> null
            else -> p.l().mapNotNull { it.s() }.toSet()
        }
        val apps = m["apps"]?.l()?.mapNotNull { it.s() }?.toSet()
        return Grants(publishers, apps, grounding = m["grounding"]?.bool() == true)
    }
}
