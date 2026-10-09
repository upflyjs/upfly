<template>
  <div class="widget">
    <img src="/brand.png" alt="Root-relative, in a template nothing reads" />
    <img src="../assets/chart.png" alt="Relative, in a template nothing reads" />
    <img :src="heroPath" alt="Bound, from the script block" />
    <img src="/img/missing-from-vue.png" alt="Broken, and invisible to every instrument" />
    <img src="/gallery/hero%20image.png" alt="Percent-encoded, as a browser asks for it" />
    <img src="/gallery/hero&#32;image.png" alt="The space as a character reference" />
  </div>
</template>

<script setup>
import logo from '../components/logo.png';

const heroPath = '/img/hero.jpg';
const shared = '../../../../shared/assets/img/thumb.png';
</script>

<style scoped>
.widget {
  background-image: url('/img/texture.png');
}
.widget__crest {
  background-image: url('../assets/inline-logo.jpg');
}
</style>
