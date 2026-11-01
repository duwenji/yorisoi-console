package console.validator

import io.github.duwenji.yorisoi.core.format.AccountIds
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class MachineReviewTest {
    private val keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val publicKey = keys.public.encoded.takeLast(32).toByteArray()
    private val account = AccountIds.of(publicKey)

    private fun b64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    private fun hex(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun manifest(id: String = "kamakura-history", version: Int = 3, publisher: String = account) = JSONObject(
        """
        {
          "format": 1, "id": "$id", "version": $version, "publisher": "$publisher",
          "name": "鎌倉歴史散歩", "summary": "鎌倉の寺社と武士の歴史を、語り部の口調で", "lang": "ja",
          "activities": ["walk"],
          "greeting": "ここからは、鎌倉の歴史をたどりながら歩きましょう。",
          "talk": { "level": "normal",
                    "events": { "spot": true, "revisit": true, "milestone": true, "rest": false, "start": true, "finish": true } },
          "spots": { "prefer": ["temple", "shrine", "historic"], "skip": ["artwork"] },
          "guide": { "length": "long" },
          "mood": { "tone": true, "sound": "temple" }
        }
        """.trimIndent(),
    )

    /** A package signed the way the console's publisher screen signs it. */
    private fun pkg(manifest: JSONObject = manifest(), tamper: Boolean = false): ByteArray {
        val files = linkedMapOf(
            "channel.json" to manifest.toString().toByteArray(),
            "prompts/guide/focus.md" to "- 由来と、関わった人物を中心に話す\n".toByteArray(),
        )
        val payload = JSONObject()
            .put("type", "channel-package").put("channel", manifest.getString("id")).put("version", manifest.getInt("version"))
            .put("publisher", account).put("files", JSONObject(files.mapValues { hex(it.value) }))
            .toString().toByteArray()
        val sig = Signature.getInstance("Ed25519").run { initSign(keys.private); update(payload); sign() }
        files["signature.json"] = JSONObject().put("payload", b64(payload)).put("publisherKey", b64(publicKey)).put("sig", b64(sig)).toString().toByteArray()
        if (tamper) files["prompts/guide/focus.md"] = "- 書き換えた指示\n".toByteArray()
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip -> files.forEach { (name, bytes) -> zip.putNextEntry(ZipEntry(name)); zip.write(bytes); zip.closeEntry() } }
        return out.toByteArray()
    }

    private fun png(width: Int = 256, height: Int = 256, size: Int = 64): ByteArray {
        val bytes = ByteArray(maxOf(size, 33))
        byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a).copyInto(bytes)
        "IHDR".toByteArray().copyInto(bytes, 12)
        for ((at, v) in listOf(16 to width, 20 to height)) for (i in 0..3) bytes[at + i] = (v shr (24 - 8 * i)).toByte()
        return bytes
    }

    private val upload = Upload("kamakura-history", "01J0000000000000000000000A", account, latestApprovedVersion = 2)

    private fun codes(outcome: Outcome): List<String> {
        assertTrue("expected a failure, got $outcome", outcome is Outcome.Failed)
        return (outcome as Outcome.Failed).findings.map { it.code }
    }

    @Test
    fun `a signed package by the publisher, newer than the approved one, passes with its samples`() {
        val outcome = MachineReview.review(upload, pkg(), png())
        assertTrue("$outcome", outcome is Outcome.Passed)
        outcome as Outcome.Passed
        assertEquals(3, outcome.version)
        val samples = JSONObject(outcome.samplePrompts)
        assertEquals(MachineReview.VALIDATOR, samples.getString("generatedBy"))
        // The review policy's scenes (2.7), as the app would render them; this channel doesn't talk on rest.
        val ids = (0 until samples.getJSONArray("scenarios").length()).map { samples.getJSONArray("scenarios").getJSONObject(it).getString("id") }
        assertEquals(9, ids.size)
        assertTrue("rest" !in ids)
        assertTrue(samples.getJSONArray("scenarios").getJSONObject(0).getString("system").contains("守ること"))
    }

    @Test
    fun `the package must be for this channel, by this publisher, and newer`() {
        assertEquals(listOf("id_mismatch"), codes(MachineReview.review(upload, pkg(manifest(id = "other-channel")), png())))
        assertEquals(listOf("publisher_mismatch"), codes(MachineReview.review(upload.copy(accountId = "sg1" + "b".repeat(32)), pkg(), png())))
        assertEquals(listOf("version_not_newer"), codes(MachineReview.review(upload.copy(latestApprovedVersion = 3), pkg(), png())))
        assertTrue(MachineReview.review(upload.copy(latestApprovedVersion = null), pkg(), png()) is Outcome.Passed)
    }

    @Test
    fun `core-format's own checks come through with their codes`() {
        assertEquals(listOf("bad_signature"), codes(MachineReview.review(upload, pkg(tamper = true), png())))
        assertEquals(listOf("bad_archive"), codes(MachineReview.review(upload, "not a zip".toByteArray(), png())))
        val failed = MachineReview.review(upload, pkg(manifest().put("talk", JSONObject().put("level", "loud"))), png())
        assertTrue(codes(failed).single() in listOf("bad_value", "bad_manifest", "bad_signature"))
    }

    @Test
    fun `the icon must be a small PNG, and both problems are reported`() {
        assertEquals(listOf("bad_icon"), codes(MachineReview.review(upload, pkg(), "GIF89a".toByteArray())))
        assertEquals(listOf("bad_icon"), codes(MachineReview.review(upload, pkg(), png(width = 512))))
        assertEquals(listOf("bad_icon"), codes(MachineReview.review(upload, pkg(), png(size = 100 * 1024 + 1))))
        assertEquals(listOf("bad_signature", "bad_icon"), codes(MachineReview.review(upload, pkg(tamper = true), png(height = 0))))
    }

    @Test
    fun `timestamps and ids match the console API's form`() {
        assertEquals("2026-10-04T03:00:00.000Z", Handler.iso(java.time.Instant.parse("2026-10-04T03:00:00Z")))
        assertTrue(Handler.ulid(java.time.Instant.now()).matches(Regex("[0-9A-HJKMNP-TV-Z]{26}")))
    }

    // ---- the ecosystem (DES-011) ----

    private fun forActivities(vararg activities: String) = manifest().apply {
        put("activities", org.json.JSONArray(activities.toList()))
        put("genres", org.json.JSONArray(listOf("history")))
        put("requires", JSONObject().put("features", org.json.JSONArray(listOf("slot:guide"))))
    }

    @Test
    fun `a package records what the list copies for the apps (N-3)`() {
        val outcome = MachineReview.review(upload, pkg(forActivities("walk", "cycle")), png()) as Outcome.Passed
        assertEquals(listOf("walk", "cycle"), outcome.listing.activities)
        assertEquals(listOf("history"), outcome.listing.genres)
        assertEquals(listOf("slot:guide"), outcome.listing.requires)
        assertTrue(JSONObject(outcome.samplePrompts).getJSONArray("scenarios").length() > 0)
    }

    @Test
    fun `values outside the ecosystem's lists are turned away (API-CHANNEL-PACKAGE V-24)`() {
        assertEquals(listOf("bad_value"), codes(MachineReview.review(upload, pkg(forActivities("drive")), png())))
        assertEquals(listOf("bad_manifest"), codes(MachineReview.review(upload, pkg(manifest().apply { remove("activities") }), png())))
        assertEquals(listOf("unsupported_format"), codes(MachineReview.review(upload, pkg(manifest().put("format", 2)), png())))
    }

    private fun scenarioIds(outcome: Outcome): List<String> {
        val scenarios = JSONObject((outcome as Outcome.Passed).samplePrompts).getJSONArray("scenarios")
        return (0 until scenarios.length()).map { scenarios.getJSONObject(it).getString("id") }
    }

    @Test
    fun `each activity's representative app renders its samples, both for a channel of both (X-6, AC-23)`() {
        val walk = scenarioIds(MachineReview.review(upload, pkg(forActivities("walk")), png()))
        val cycle = scenarioIds(MachineReview.review(upload, pkg(forActivities("cycle")), png()))
        val both = scenarioIds(MachineReview.review(upload, pkg(forActivities("walk", "cycle")), png()))
        assertTrue(walk.isNotEmpty() && walk.none { it.startsWith("ride-") })
        assertTrue(cycle.isNotEmpty() && cycle.all { it.startsWith("ride-") })
        assertEquals(walk + cycle, both)
        val cycleOnly = JSONObject((MachineReview.review(upload, pkg(forActivities("cycle")), png()) as Outcome.Passed).samplePrompts)
        assertTrue(!cycleOnly.has("noRepresentativeApp"))
        assertTrue(cycleOnly.getJSONArray("scenarios").getJSONObject(0).getString("label").startsWith("自転車: "))
    }
}
