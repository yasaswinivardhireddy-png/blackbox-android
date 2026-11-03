plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "io.github.yasaswini.blackbox.sample"
    compileSdk = 36
    ndkVersion = "27.3.13750724"

    defaultConfig {
        applicationId = "io.github.yasaswini.blackbox.sample"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        val endpoint = providers.gradleProperty("blackbox.endpoint").getOrElse("http://127.0.0.1:8080")
        buildConfigField("String", "BLACKBOX_ENDPOINT", "\"$endpoint\"")
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.31.5"
        }
    }

    buildTypes {
        release {
            // Shipped configuration: R8 shrinks and obfuscates, and the backend retraces with mapping.txt.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":blackbox"))
    implementation(libs.kotlinx.coroutines.android)
}
