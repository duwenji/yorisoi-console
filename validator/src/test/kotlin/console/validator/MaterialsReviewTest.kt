package console.validator

import io.github.duwenji.yorisoi.core.format.material.Grants
import io.github.duwenji.yorisoi.core.format.AccountIds
import io.github.duwenji.yorisoi.core.format.ListedCollection
import io.github.duwenji.yorisoi.core.format.PackageRef
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.time.Instant
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** DES-007: channels with material and collections they use (J-1・J-2), and collection submissions (J-4〜J-8). */
class MaterialsReviewTest {
    private class Signer(val keys: KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()) {
        val publicKey: ByteArray = keys.public.encoded.takeLast(32).toByteArray()
        val account: String = AccountIds.of(publicKey)
        fun sign(bytes: ByteArray): ByteArray = Signature.getInstance("Ed25519").run { initSign(keys.private); update(bytes); sign() }
    }

    private val publisher = Signer()
    private val producer = Signer()

    private fun b64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    private fun hex(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** A signed package of [files]: `type` channel-package or collection-package. */
    private fun signedZip(files: Map<String, ByteArray>, signer: Signer, type: String, subjectKey: String, ownerKey: String, id: String, version: Int): ByteArray {
        val all = LinkedHashMap(files)
        val payload = JSONObject()
            .put("type", type).put(subjectKey, id).put("version", version)
            .put(ownerKey, signer.account).put("files", JSONObject(files.mapValues { hex(it.value) }))
            .toString().toByteArray()
        all["signature.json"] = JSONObject().put("payload", b64(payload)).put("publisherKey", b64(signer.publicKey)).put("sig", b64(signer.sign(payload)))
            .toString().toByteArray()
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip -> all.forEach { (name, bytes) -> zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry() } }
        return out.toByteArray()
    }

    // ---- a collection ----

    private val audioBytes = "OggS fake narration".toByteArray()

    private fun collectionJson(version: Int = 2, grants: Any = "*", change: JSONObject.() -> Unit = {}) = JSONObject(
        """
        {
          "format": 1, "id": "kamakura-audio-guide", "version": $version, "producer": "${producer.account}",
          "name": "鎌倉音声ガイド", "summary": "寺社の音声ガイド", "lang": "ja",
          "resources": [
            { "id": "intro", "type": "text", "file": "resources/text/intro.md", "tags": ["history"],
              "about": { "type": "spot", "osm": "way/123456", "name": "鶴岡八幡宮", "lat": 35.3260, "lon": 139.5565 } },
            { "id": "narration", "type": "audio", "url": "https://cdn.example.com/n.ogg", "sha256": "${hex(audioBytes)}", "size": ${audioBytes.size},
              "durationSec": 60, "mime": "audio/ogg", "transcript": "intro", "credit": { "author": "鎌倉市観光協会", "license": "permission" } }
          ]
        }
        """.trimIndent(),
    ).put("grants", JSONObject().put("publishers", grants)).apply(change)

    private fun collectionZip(json: JSONObject = collectionJson()): ByteArray = signedZip(
        mapOf("collection.json" to json.toString().toByteArray(), "resources/text/intro.md" to "鶴岡八幡宮の話です。\n".toByteArray()),
        producer, "collection-package", "collection", "producer", json.getString("id"), json.getInt("version"),
    )

    /** Serves [audioBytes] at the narration's URL, and nothing else. */
    private val fetcher = ExternalFetcher { url, max ->
        if (url == "https://cdn.example.com/n.ogg" && audioBytes.size <= max) Fetched.Ok(audioBytes.size.toLong(), hex(audioBytes)) else Fetched.Failed("HTTP 404")
    }

    private val collectionUpload = CollectionUpload("kamakura-audio-guide", "01J0000000000000000000000C", producer.account, latestApprovedVersion = 1)

    // ---- a channel using it ----

    private fun channelZip(cues: JSONArray, collections: JSONArray = JSONArray().put(JSONObject().put("as", "kamakura").put("id", "kamakura-audio-guide").put("minVersion", 2))): ByteArray {
        val manifest = JSONObject(
            """
            {
              "format": 1, "id": "kamakura-history", "version": 3, "publisher": "${publisher.account}",
              "name": "鎌倉歴史散歩", "summary": "鎌倉の寺社と武士の歴史", "lang": "ja", "activities": ["walk"], "greeting": "歩きましょう。",
              "talk": { "level": "normal", "events": { "spot": true, "revisit": true, "milestone": true, "rest": true, "start": true, "finish": true } },
              "spots": { "prefer": [], "skip": [] }, "guide": { "length": "normal" }, "mood": { "tone": true, "sound": "auto" }
            }
            """.trimIndent(),
        ).put("collections", collections).put("cues", cues)
        return signedZip(mapOf("channel.json" to manifest.toString().toByteArray()), publisher, "channel-package", "channel", "publisher", "kamakura-history", 3)
    }

    private fun cue(asWhat: String, source: Any) = JSONObject().put("id", "hachimangu")
        .put("trigger", JSONObject().put("type", "spot").put("osm", "way/123456"))
        .put("present", JSONArray().put(JSONObject().put("as", asWhat).put("source", source)))

    private fun png(): ByteArray {
        val bytes = ByteArray(64)
        byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a).copyInto(bytes)
        "IHDR".toByteArray().copyInto(bytes, 12)
        bytes[19] = 64; bytes[23] = 64
        return bytes
    }

    private fun catalog(grants: Grants = Grants.EVERYONE, zip: ByteArray = collectionZip(), listed: Boolean = true) = object : Catalog {
        override fun listed(collectionId: String) = if (!listed || collectionId != "kamakura-audio-guide") null else ListedCollection(
            collectionId, 2, producer.account, "", null, "鎌倉音声ガイド", "寺社の音声ガイド", listOf("text", "audio"), 1000,
            listOf("history"), listOf("xn7"), grants, PackageRef("https://cdn.example.com/col/x.zip", hex(zip), zip.size, 1), Instant.EPOCH, mapOf("sanpoguide" to 14),
        )
        override fun pkg(listed: ListedCollection) = zip
    }

    private val upload = Upload("kamakura-history", "01J0000000000000000000000A", publisher.account, latestApprovedVersion = 2)

    @Test
    fun `a channel playing a listed collection's audio passes at stage 2 with what approval copies`() {
        val outcome = MachineReview.review(upload, channelZip(JSONArray().put(cue("play", "kamakura#narration"))), png(), catalog())
        assertTrue("$outcome", outcome is Outcome.Passed)
        outcome as Outcome.Passed
        assertEquals(listOf(CollectionResult("kamakura", "kamakura-audio-guide", true, null, null)), outcome.collections)
        assertEquals(2, outcome.listing.appStage)
        assertEquals(listOf(Triple("kamakura", "kamakura-audio-guide", 2)), outcome.listing.collections)
        assertEquals(mapOf("kamakura-audio-guide" to mapOf("narration" to "audio")), outcome.listing.uses)
    }

    @Test
    fun `a channel can't use a collection that isn't listed, isn't granted, or lacks the resource`() {
        fun failed(o: Outcome): Outcome.Failed { assertTrue("$o", o is Outcome.Failed); return o as Outcome.Failed }
        val play = channelZip(JSONArray().put(cue("play", "kamakura#narration")))
        val notListed = failed(MachineReview.review(upload, play, png(), catalog(listed = false)))
        assertEquals(listOf("collection_not_listed"), notListed.findings.map { it.code })
        assertEquals("unusable", if (notListed.collections.single().usable) "usable" else "unusable")

        val other = Grants(setOf("sg1" + "z".repeat(32)))
        val grantZip = collectionZip(collectionJson(grants = JSONArray().put("sg1" + "z".repeat(32))))
        assertEquals(listOf("not_granted"), failed(MachineReview.review(upload, play, png(), catalog(grants = other, zip = grantZip))).findings.map { it.code })
        // Granted to the publisher's id before a key transfer: still usable (API-MATERIALS W-13).
        val former = "sg1" + "y".repeat(32)
        val toFormer = collectionZip(collectionJson(grants = JSONArray().put(former)))
        val moved = MachineReview.review(upload.copy(formerAccountIds = setOf(former)), play, png(), catalog(Grants(setOf(former)), toFormer))
        assertTrue("$moved", moved is Outcome.Passed)

        val missing = channelZip(JSONArray().put(cue("play", "kamakura#missing")))
        assertEquals(listOf("unresolved_reference"), failed(MachineReview.review(upload, missing, png(), catalog())).findings.map { it.code })
    }

    @Test
    fun `a collection passes with its outside resources checked and what approval copies`() {
        val outcome = MachineReview.reviewCollection(collectionUpload, collectionZip(), fetcher)
        assertTrue("$outcome", outcome is CollectionOutcome.Passed)
        outcome as CollectionOutcome.Passed
        assertEquals(listOf(ExternalResult("narration", true, null)), outcome.external)
        val l = outcome.listing
        assertEquals(2, l.appStage)
        assertEquals(listOf("audio", "text"), l.media)
        assertEquals(listOf("history"), l.tags)
        assertEquals(listOf("xn7"), l.regions)
        assertEquals(mapOf("intro" to "text", "narration" to "audio"), l.resourceTypes)
        assertEquals(listOf(Triple("narration", "https://cdn.example.com/n.ogg", audioBytes.size.toLong())), l.externalResources)
        assertEquals(outcome.size + audioBytes.size.toLong(), l.resourcesSize)
    }

    @Test
    fun `a collection must be this one, by this producer, newer, with outside resources as declared`() {
        fun codes(o: CollectionOutcome) = (o as CollectionOutcome.Failed).findings.map { it.code }
        assertEquals(listOf("id_mismatch"), codes(MachineReview.reviewCollection(collectionUpload.copy(collectionId = "other-guide"), collectionZip(), fetcher)))
        assertEquals(listOf("publisher_mismatch"), codes(MachineReview.reviewCollection(collectionUpload.copy(accountId = publisher.account), collectionZip(), fetcher)))
        assertEquals(listOf("version_not_newer"), codes(MachineReview.reviewCollection(collectionUpload.copy(latestApprovedVersion = 2), collectionZip(), fetcher)))
        val changed = ExternalFetcher { _, _ -> Fetched.Ok(audioBytes.size.toLong(), "0".repeat(64)) }
        assertEquals(listOf("resource_mismatch"), codes(MachineReview.reviewCollection(collectionUpload, collectionZip(), changed)))
        val refused = ExternalFetcher { _, _ -> Fetched.Refused("10.0.0.5 is not a public address") }
        val failed = MachineReview.reviewCollection(collectionUpload, collectionZip(), refused) as CollectionOutcome.Failed
        assertEquals(listOf("bad_resource"), failed.findings.map { it.code })
        assertEquals(false, failed.external.single().ok)
        // Out of time: what isn't read yet is reported, not waited for.
        var now = 0L
        val slow = MachineReview.reviewCollection(collectionUpload, collectionZip(), fetcher) { now.also { now += MachineReview.EXTERNAL_BUDGET_MS + 1 } }
        assertEquals(listOf("resource_mismatch"), codes(slow))
    }

    @Test
    fun `resources a listed channel names must stay, with their type, and narrowed grants are a warning`() {
        val using = UsedBy("kamakura-history", setOf(publisher.account), mapOf("narration" to "audio", "intro" to "text"))
        val withoutNarration = collectionJson(version = 3) { getJSONArray("resources").remove(1) }
        val removed = MachineReview.reviewCollection(collectionUpload.copy(usedBy = listOf(using)), collectionZip(withoutNarration), fetcher)
        removed as CollectionOutcome.Failed
        assertEquals(listOf("resource_in_use"), removed.findings.map { it.code })
        assertEquals(listOf(InUse("kamakura-history", "narration", "removed")), removed.inUse)

        val typeChanged = UsedBy("kamakura-history", setOf(publisher.account), mapOf("intro" to "image"))
        val changed = MachineReview.reviewCollection(collectionUpload.copy(usedBy = listOf(typeChanged)), collectionZip(), fetcher) as CollectionOutcome.Failed
        assertEquals("type changed from image to text", changed.inUse.single().detail)

        val narrowed = collectionZip(collectionJson(grants = JSONArray().put("sg1" + "z".repeat(32))))
        val warned = MachineReview.reviewCollection(collectionUpload.copy(usedBy = listOf(using)), narrowed, fetcher)
        assertTrue("$warned", warned is CollectionOutcome.Passed)
        assertEquals(listOf("grants_narrowed"), warned.warnings.map { it.code })
    }
}
