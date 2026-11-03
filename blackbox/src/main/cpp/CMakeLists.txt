cmake_minimum_required(VERSION 3.22.1)
project(blackbox LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(blackbox SHARED blackbox_native.cpp)

target_compile_options(blackbox PRIVATE
    -Wall -Wextra -Werror
    -fvisibility=hidden
    -fno-exceptions -fno-rtti
    -ffunction-sections -fdata-sections)

target_link_options(blackbox PRIVATE
    "-Wl,--gc-sections"
    "-Wl,--build-id=sha1"
    # 16 KB page-size compatible (required for apps targeting Android 15+ devices with 16 KB pages).
    "-Wl,-z,max-page-size=16384")
