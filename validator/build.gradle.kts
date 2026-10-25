import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The machine review (ADR-001 A-11): a Lambda that checks an uploaded package with the very code
// the app uses (yorisoi core-format), and renders the review samples with SanpoGuide's prompt pack
// (API-001 C-1). Published by yorisoi-platform and yorisoi-sanpoguide.
plugins {
    kotlin("jvm") version "2.2.0"
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("io.github.duwenji.yorisoi:core-format:2.15.0")
    implementation("io.github.duwenji.yorisoi.sanpoguide:prompts:4.2.0")
    implementation("io.github.duwenji.yorisoi.cycleguide:prompts:0.1.0")
    // core-format leaves org.json to its users (Android ships one).
    implementation("org.json:json:20240303")
    implementation("com.amazonaws:aws-lambda-java-core:1.4.0")
    implementation("com.amazonaws:aws-lambda-java-events:3.16.1")
    implementation(platform("software.amazon.awssdk:bom:2.55.11"))
    implementation("software.amazon.awssdk:s3") {
        exclude(group = "software.amazon.awssdk", module = "netty-nio-client")
        exclude(group = "software.amazon.awssdk", module = "apache-client")
    }
    implementation("software.amazon.awssdk:dynamodb") {
        exclude(group = "software.amazon.awssdk", module = "netty-nio-client")
        exclude(group = "software.amazon.awssdk", module = "apache-client")
    }
    // The JDK's HTTP client: smaller and quicker to start than Apache or Netty.
    implementation("software.amazon.awssdk:url-connection-client")

    testImplementation("junit:junit:4.13.2")
}

/** The Lambda deployment package: classes at the root, dependencies in lib/. */
val lambdaZip by tasks.registering(Zip::class) {
    archiveFileName.set("validator.zip")
    destinationDirectory.set(layout.buildDirectory.dir("lambda"))
    from(tasks.compileKotlin)
    from(tasks.processResources)
    into("lib") { from(configurations.runtimeClasspath) }
}
tasks.build { dependsOn(lambdaZip) }
