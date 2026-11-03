cmake_minimum_required(VERSION 3.22.1)
project(crashy LANGUAGES CXX)

add_library(crashy SHARED crashy.cpp)

# Optimized like production code; FORTIFY turns the buffer overflow into a clean abort.
target_compile_options(crashy PRIVATE -O2 -D_FORTIFY_SOURCE=2 -fno-omit-frame-pointer -Wall -Wextra)
target_link_libraries(crashy log)
target_link_options(crashy PRIVATE "-Wl,--build-id=sha1" "-Wl,-z,max-page-size=16384")
