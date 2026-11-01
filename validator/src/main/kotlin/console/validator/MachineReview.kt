package console.validator

import io.github.duwenji.yorisoi.core.format.Activity
import io.github.duwenji.yorisoi.core.format.material.CollectionCheck
import io.github.duwenji.yorisoi.core.format.material.CollectionListedAs
import io.github.duwenji.yorisoi.core.format.material.CollectionPackage
import io.github.duwenji.yorisoi.core.format.material.CollectionValidator
import io.github.duwenji.yorisoi.core.format.material.Grants
import io.github.duwenji.yorisoi.core.format.material.MaterialType
import io.github.duwenji.yorisoi.core.format.material.Regions
import io.github.duwenji.yorisoi.core.format.material.ResourceLocation
import io.github.duwenji.yorisoi.cycleguide.prompt.ReviewSamples as CycleSamples
import io.github.duwenji.yorisoi.sanpoguide.prompt.ReviewSamples as WalkSamples
import io.github.duwenji.yorisoi.core.format.ChannelList
import io.github.duwenji.yorisoi.core.format.CollectionReferences
import io.github.duwenji.yorisoi.core.format.CollectionStatus
import io.github.duwenji.yorisoi.core.format.FileRef
import io.github.duwenji.yorisoi.core.format.JcaEd25519
import io.github.duwenji.yorisoi.core.format.ListedChannel
import io.github.duwenji.yorisoi.core.format.ListedCollection
import io.github.duwenji.yorisoi.core.format.MediaStage
import io.github.duwenji.yorisoi.core.format.PackageRef
import io.github.duwenji.yorisoi.core.format.PublisherChange
import io.github.duwenji.yorisoi.core.format.StationCheck
import io.github.duwenji.yorisoi.core.format.StationValidator
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

/** What the console knows about a submission when its files arrive (DM-001 SUBMISSION). */
data class Upload(
    val channelId: String,
    val submissionId: String,
    /** The publisher's account id when they submitted; the package must be signed by it. */
    val accountId: String,
    /** The version last approved for this channel, if any (DM-001 M-5). */
    val latestApprovedVersion: Int?,
    /** The account's ids before it moved to a new key: a collection granted to one still counts (API-MATERIALS W-13). */
    val formerAccountIds: Set<String> = emptySet(),
)

/** One reason a submission failed, with API-CHANNEL-PACKAGE's code where there is one (API-001 `Validation`). */
data class Finding(val code: String, val detail: String)

/** The collections that are listed now, as the list would show them (DES-007 J-2). */
interface Catalog {
    fun listed(collectionId: String): ListedCollection?

    /** The listed version's package, from the public bucket. */
    fun pkg(listed: ListedCollection): ByteArray?

    companion object {
        val NONE = object : Catalog {
            override fun listed(collectionId: String): ListedCollection? = null
            override fun pkg(listed: ListedCollection): ByteArray? = null
        }
    }
}

/** How one declared collection resolved (API-001 C-19 `validation.collections`). */
data class CollectionResult(val alias: String, val collectionId: String, val usable: Boolean, val code: String?, val detail: String?)

/**
 * What approval copies for a channel (DES-007 J-10, DM-001 `latestApproved`): its stage counted with
 * the collections it uses, its declarations, its own prefetch and media, and the resources it
 * names in each collection (by collection id, with their types) for the record of use (M-22).
 */
data class ChannelListing(
    val appStage: Int,
    val collections: List<Triple<String, String, Int>>,
    val ownPrefetchBytes: Long,
    val ownMedia: List<String>,
    val uses: Map<String, Map<String, String>>,
    /** As the package writes them; format 1's are walk, none, none (DES-011 N-3, API-CHANNEL-PACKAGE G-6). */
    val activities: List<String> = listOf(Activity.WALK.json),
    val genres: List<String> = emptyList(),
    val requires: List<String> = emptyList(),
)

sealed interface Outcome {
    data class Passed(
        val version: Int,
        val sha256: String,
        val size: Int,
        val iconSha256: String,
        /** The review samples' prompts as API-001 `SamplePrompts` JSON (API-001 C-1). */
        val samplePrompts: String,
        val listing: ChannelListing,
        val collections: List<CollectionResult>,
    ) : Outcome

    data class Failed(val findings: List<Finding>, val version: Int?, val collections: List<CollectionResult> = emptyList()) : Outcome
}

/** What the console knows about a collection submission (DM-001). */
data class CollectionUpload(
    val collectionId: String,
    val submissionId: String,
    /** The producer's account id when they submitted; the package must be signed by it. */
    val accountId: String,
    val latestApprovedVersion: Int?,
    /** The listed channels that use this collection (DM-001 USEDBY), for D-8 and narrowed grants. */
    val usedBy: List<UsedBy> = emptyList(),
)

/** One record of use: a channel, its publisher's ids (now and before a key transfer), and the resources it names with their types. */
data class UsedBy(val channelId: String, val publisherIds: Set<String>, val resources: Map<String, String>)

data class ExternalResult(val resourceId: String, val ok: Boolean, val detail: String?)

data class InUse(val channelId: String, val resourceId: String, val detail: String)

/** What approval copies for a collection (DES-007 J-8, DM-001 `latestApproved`). */
data class CollectionListing(
    val appStage: Int,
    val name: String,
    val summary: String,
    val media: List<String>,
    val resourcesSize: Long,
    val tags: List<String>,
    val regions: List<String>,
    val grants: Grants,
    val resourceTypes: Map<String, String>,
    /** resource id, URL, size. */
    val externalResources: List<Triple<String, String, Long>>,
)

sealed interface CollectionOutcome {
    val external: List<ExternalResult>
    val warnings: List<Finding>

    data class Passed(
        val version: Int,
        val sha256: String,
        val size: Int,
        val listing: CollectionListing,
        override val external: List<ExternalResult>,
        override val warnings: List<Finding>,
    ) : CollectionOutcome

    data class Failed(
        val findings: List<Finding>,
        val version: Int?,
        override val external: List<ExternalResult> = emptyList(),
        val inUse: List<InUse> = emptyList(),
        override val warnings: List<Finding> = emptyList(),
    ) : CollectionOutcome
}

/**
 * The machine review (ADR-001 A-11, API-CHANNEL-PACKAGE 確認の手順 2〜10, API-MATERIALS 確かめる手順 1〜4):
 * core-format's checks, the same the app runs, plus what only the console knows (which channel or
 * collection, which account, which version came before, which channels use a collection) and the
 * icon. Pure: the Lambda reads and writes, this decides.
 */
object MachineReview {
    const val VALIDATOR = "core-format 2.15.0, sanpoguide prompts 4.2.0, cycleguide prompts 0.1.0"
    const val MAX_PACKAGE = 2 * 1024 * 1024
    const val MAX_ICON = 100 * 1024
    const val MAX_ICON_SIDE = 256

    /** DES-007 J-5: all of a collection's outside resources are read within this. */
    const val EXTERNAL_BUDGET_MS = 10 * 60 * 1000L

    fun review(upload: Upload, zip: ByteArray, icon: ByteArray, catalog: Catalog = Catalog.NONE): Outcome {
        val findings = mutableListOf<Finding>()
        var version: Int? = null
        var passed: Outcome.Passed? = null
        var collections = emptyList<CollectionResult>()

        if (zip.size > MAX_PACKAGE) {
            findings += Finding("bad_archive", "${zip.size} bytes (max $MAX_PACKAGE)")
        } else {
            // Every stage: the console checks it all, and the app version a channel needs is minAppVersions' job (J-1).
            when (val result = StationValidator.checkArchive(zip, listedAs = null, verifier = JcaEd25519, mediaStage = StationValidator.ALL_STAGES)) {
                is StationCheck.Rejected -> findings += Finding(result.code.json, result.detail)
                is StationCheck.Ok -> {
                    val manifest = result.station.manifest
                    version = manifest.version
                    if (manifest.id != upload.channelId) findings += Finding("id_mismatch", "channel.json id is ${manifest.id}, not ${upload.channelId}")
                    if (manifest.publisher != upload.accountId) {
                        findings += Finding("publisher_mismatch", "signed for ${manifest.publisher}, the publisher's account is ${upload.accountId}")
                    }
                    upload.latestApprovedVersion?.let { latest ->
                        if (manifest.version <= latest) findings += Finding("version_not_newer", "version ${manifest.version} is not after the approved $latest")
                    }
                    val resolved = resolveCollections(upload, result, catalog)
                    collections = resolved.results
                    resolved.rejection?.let { (code, detail) -> findings += Finding(code, detail) }
                    if (findings.isEmpty()) {
                        passed = Outcome.Passed(manifest.version, sha256Hex(zip), zip.size, "", samplePrompts(result), resolved.listing, collections)
                    }
                }
            }
        }
        findings += iconFindings(icon)
        return if (findings.isEmpty()) passed!!.copy(iconSha256 = sha256Hex(icon)) else Outcome.Failed(findings.take(100), version, collections)
    }

    private class Resolved(val results: List<CollectionResult>, val rejection: Pair<String, String>?, val listing: ChannelListing)

    /** API-MATERIALS 手順 3・4 against the collections listed now (J-2); a collection not readable counts as not listed. */
    private fun resolveCollections(upload: Upload, ok: StationCheck.Ok, catalog: Catalog): Resolved {
        val media = ok.station.media
        val listed = media.collections.mapNotNull { catalog.listed(it.id) }.distinctBy { it.id }
        val packages = listed.mapNotNull { l ->
            val bytes = catalog.pkg(l) ?: return@mapNotNull null
            val listedAs = CollectionListedAs(l.id, l.version, l.producer, setOfNotNull(l.producerChange?.from))
            (CollectionValidator.checkArchive(bytes, listedAs, JcaEd25519) as? CollectionCheck.Ok)?.let { l.id to it.collection }
        }.toMap()
        val resolution = CollectionReferences.resolve(media, upload.accountId, listFor(upload, listed), packages)
        val results = media.collections.map { use ->
            when (val s = resolution.statuses.getValue(use.alias)) {
                is CollectionStatus.Usable -> CollectionResult(use.alias, use.id, true, null, null)
                is CollectionStatus.NotFetched -> CollectionResult(use.alias, use.id, false, "collection_not_listed", "the listed package could not be read")
                is CollectionStatus.Unusable -> CollectionResult(use.alias, use.id, false, s.code.json, s.detail)
            }
        }
        val rejection = results.firstOrNull { !it.usable }?.let { it.code!! to "${it.alias}: ${it.detail}" }
            ?: resolution.problems.firstOrNull()?.let { it.code.json to "${it.cue}: ${it.detail}" }
        val named = CollectionReferences.usedResources(media)
        val uses = media.collections.associate { use ->
            val pkg = (resolution.statuses[use.alias] as? CollectionStatus.Usable)?.pkg
            use.id to named[use.id].orEmpty().associateWith { id -> pkg?.resources?.get(id)?.type?.json ?: "" }
        }
        val manifest = ok.station.manifest
        val listing = ChannelListing(
            appStage = MediaStage.required(media, resolution::types),
            collections = media.collections.map { Triple(it.alias, it.id, it.minVersion) },
            ownPrefetchBytes = media.resources.prefetchBytes,
            ownMedia = media.resources.items.map { it.type.json }.distinct().sorted(),
            uses = uses,
            // Review reads with every value known (Strictness.REVIEW), so these are as written.
            activities = manifest.activities.map { it.json },
            genres = manifest.genres.map { it.json },
            requires = manifest.requires.map { it.json },
        )
        return Resolved(results, rejection, listing)
    }

    /**
     * The list [CollectionReferences.resolve] reads: the listed collections, and the account's former
     * ids as `publisherChange`s of this channel (that's where the list keeps them).
     */
    private fun listFor(upload: Upload, collections: List<ListedCollection>): ChannelList {
        val at = Instant.EPOCH
        val former = upload.formerAccountIds.map { from ->
            ListedChannel(
                upload.channelId, 0, upload.accountId, "", PublisherChange(from, at, ""), "", "", null,
                emptyList(), emptyList(), emptyList(), FileRef("", ""), PackageRef("", "", 0, 1), at,
                emptyList(), 0, emptyList(), emptyList(), emptyList(), emptyMap(),
            )
        }
        return ChannelList("console", 0, at, at, "", former, emptyList(), collections, emptyList())
    }

    /**
     * A collection submission (DES-007 J-4): core-format's checks, the collection, producer and
     * version, every outside resource's size and hash (J-5), the resources listed channels name (D-8,
     * J-7), and grants that would leave a using channel out (a warning, J-7).
     */
    fun reviewCollection(
        upload: CollectionUpload,
        zip: ByteArray,
        fetcher: ExternalFetcher,
        clockMs: () -> Long = System::currentTimeMillis,
    ): CollectionOutcome {
        if (zip.size > MAX_PACKAGE) return CollectionOutcome.Failed(listOf(Finding("bad_archive", "${zip.size} bytes (max $MAX_PACKAGE)")), null)
        val pkg = when (val result = CollectionValidator.checkArchive(zip, listedAs = null, verifier = JcaEd25519)) {
            is CollectionCheck.Rejected -> return CollectionOutcome.Failed(listOf(Finding(result.code.json, result.detail)), null)
            is CollectionCheck.Ok -> result.collection
        }
        val manifest = pkg.manifest
        val findings = mutableListOf<Finding>()
        if (manifest.id != upload.collectionId) findings += Finding("id_mismatch", "collection.json id is ${manifest.id}, not ${upload.collectionId}")
        if (manifest.producer != upload.accountId) findings += Finding("publisher_mismatch", "signed for ${manifest.producer}, the producer's account is ${upload.accountId}")
        upload.latestApprovedVersion?.let { latest ->
            if (manifest.version <= latest) findings += Finding("version_not_newer", "version ${manifest.version} is not after the approved $latest")
        }

        val external = checkExternal(pkg, fetcher, clockMs)
        external.filter { !it.ok }.forEach { findings += Finding(if (it.detail?.startsWith(REFUSED) == true) "bad_resource" else "resource_mismatch", "${it.resourceId}: ${it.detail}") }

        val inUse = upload.usedBy.flatMap { use ->
            use.resources.mapNotNull { (id, type) ->
                val now = pkg.resources[id]
                when {
                    now == null -> InUse(use.channelId, id, "removed")
                    type.isNotEmpty() && now.type.json != type -> InUse(use.channelId, id, "type changed from $type to ${now.type.json}")
                    else -> null
                }
            }
        }
        inUse.forEach { findings += Finding("resource_in_use", "${it.channelId} uses ${it.resourceId}: ${it.detail}") }

        val warnings = upload.usedBy.filter { use -> use.publisherIds.none(manifest.grants::allows) }
            .map { Finding("grants_narrowed", "${it.channelId} can no longer use it") }

        if (findings.isNotEmpty()) return CollectionOutcome.Failed(findings.take(100), manifest.version, external, inUse, warnings)
        return CollectionOutcome.Passed(manifest.version, sha256Hex(zip), zip.size, listing(pkg, zip.size), external, warnings)
    }

    private const val REFUSED = "refused: "

    private fun checkExternal(pkg: CollectionPackage, fetcher: ExternalFetcher, clockMs: () -> Long): List<ExternalResult> {
        val start = clockMs()
        return pkg.resources.items.mapNotNull { r ->
            val outside = r.location as? ResourceLocation.External ?: return@mapNotNull null
            if (clockMs() - start > EXTERNAL_BUDGET_MS) return@mapNotNull ExternalResult(r.id, false, "not checked: out of time")
            when (val got = fetcher.fetch(outside.url, outside.size)) {
                is Fetched.Refused -> ExternalResult(r.id, false, REFUSED + got.detail)
                is Fetched.Failed -> ExternalResult(r.id, false, got.detail)
                is Fetched.Ok -> when {
                    got.size != outside.size -> ExternalResult(r.id, false, "size ${got.size}, not ${outside.size}")
                    got.sha256 != outside.sha256 -> ExternalResult(r.id, false, "sha256 differs")
                    else -> ExternalResult(r.id, true, null)
                }
            }
        }
    }

    /** The values approval copies (J-8; DM-001 M-23・M-24, API-CHANNEL-LIST P-15). */
    private fun listing(pkg: CollectionPackage, packageSize: Int): CollectionListing {
        val items = pkg.resources.items
        val stage = items.maxOf { if (it.type == MaterialType.VIDEO) 3 else if (it.type == MaterialType.AUDIO) 2 else 1 }
        return CollectionListing(
            appStage = stage,
            name = pkg.manifest.name,
            summary = pkg.manifest.summary,
            media = items.map { it.type.json }.distinct().sorted(),
            resourcesSize = packageSize + pkg.resources.prefetchBytes,
            tags = items.flatMap { it.tags }.distinct().sorted(),
            regions = Regions.of(pkg.resources),
            grants = pkg.manifest.grants,
            resourceTypes = items.associate { it.id to it.type.json },
            externalResources = items.mapNotNull { r -> (r.location as? ResourceLocation.External)?.let { Triple(r.id, it.url, it.size) } },
        )
    }

    /** PNG, at most 256×256, at most 100KB (API-001 申請). */
    fun iconFindings(icon: ByteArray): List<Finding> {
        if (icon.size > MAX_ICON) return listOf(Finding("bad_icon", "${icon.size} bytes (max $MAX_ICON)"))
        val signature = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        // The first chunk of a PNG is IHDR: width and height, big-endian, at bytes 16 and 20.
        if (icon.size < 24 || !icon.copyOfRange(0, 8).contentEquals(signature) || String(icon, 12, 4, Charsets.US_ASCII) != "IHDR") {
            return listOf(Finding("bad_icon", "not a PNG"))
        }
        fun int(at: Int) = ((icon[at].toInt() and 0xff) shl 24) or ((icon[at + 1].toInt() and 0xff) shl 16) or
            ((icon[at + 2].toInt() and 0xff) shl 8) or (icon[at + 3].toInt() and 0xff)
        val width = int(16)
        val height = int(20)
        return if (width in 1..MAX_ICON_SIDE && height in 1..MAX_ICON_SIDE) emptyList()
        else listOf(Finding("bad_icon", "${width}×$height (max ${MAX_ICON_SIDE}×$MAX_ICON_SIDE)"))
    }

    /**
     * The scenes the AI is asked to speak, with the prompts of each activity's representative app
     * (platform ADR-ECOSYSTEM-PLATFORM E-26): SanpoGuide's for walking, CycleGuide's for cycling,
     * both for a channel of both. A channel of neither has none (DES-011 N-8); the operator reads
     * its slots instead.
     */
    private fun samplePrompts(ok: StationCheck.Ok): String {
        val scenarios = JSONArray()
        val activities = ok.station.manifest.activities
        val walking = Activity.WALK in activities
        val cycling = Activity.CYCLE in activities
        val samples = (if (walking) WalkSamples.build(ok.station).map { listOf(it.id, it.label, it.system, it.user) } else emptyList()) +
            (if (cycling) CycleSamples.build(ok.station).map { listOf(it.id, it.label, it.system, it.user) } else emptyList())
        for ((id, label, system, user) in samples) {
            scenarios.put(JSONObject().put("id", id).put("label", label).put("system", system).put("user", user))
        }
        return JSONObject().put("generatedBy", VALIDATOR).put("scenarios", scenarios)
            .apply { if (!walking && !cycling) put("noRepresentativeApp", JSONArray(activities.map { it.json })) }
            .toString()
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
